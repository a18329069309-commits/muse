import { shaBytes, validateSchema } from './audio_api.mjs';
import { projectAssemblyConsumerInput } from './assembly_consumer_projection.mjs';
import {projectAssemblyDecisionContract,restoreAssemblyDecisionValue,projectAssemblyDecisionInput} from './assembly_decision_contract.mjs';
import {bindActualTailOperandView,boundedAssemblyContinuationRevision} from './bounded_assembly_continuation.mjs';

export const compactBusinessRevision = 'compact_business_v1';
export const compactDirectionRevision = 'direction-host-refs-v1';
export const directionTerminalFullStopRecoveryRevision = 'original-terminal-u3002-v1';
export const sharedMaterialTaskContextRevision = 'material-task-context-inline-sharing-v1';
export const researchAssemblyProjectionRevision = 'assembly-selected-source-host-binding-v1';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const sharedMaterialContextFields = ['conditions', 'case_conditions', 'exclude_case_conditions', 'story_sequence', 'story_beat_ids', 'sound_goal'];
const observationMetadataFields = ['backend_id', 'model_revision', 'model_sha256', 'scope', 'time_resolution',
  'transcription_is_unverified_prediction', 'lyrics_verified', 'exact_event_onsets_verified', 'qualified'];
const predictionsIn = input => (input.tasks ?? []).flatMap(task => (task.candidates ?? []).flatMap(candidate =>
  candidate.observation?.predictions ?? []));

function encodeSharedStorySequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length < 2 || sequence.some(step => !step || typeof step !== 'object'
    || !step.before || !step.after || Array.isArray(step.before) || Array.isArray(step.after))) return sequence;
  const step_columns = Object.keys(sequence[0]), states = sequence.flatMap(step => [step.before, step.after]), condition_columns = Object.keys(states[0]);
  if (sequence.some(step => canonical(Object.keys(step).sort()) !== canonical([...step_columns].sort()))
    || states.some(state => canonical(Object.keys(state).sort()) !== canonical([...condition_columns].sort()))) return sequence;
  return { encoding: 'shared-story-condition-tables-v1', step_columns,
    step_rows: sequence.map((step, index) => step_columns.map(key => key === 'before' ? index * 2 : key === 'after' ? index * 2 + 1 : step[key])),
    condition_columns, condition_rows: states.map(state => condition_columns.map(key => state[key])) };
}

function decodeSharedStorySequence(sequence) {
  if (sequence?.encoding !== 'shared-story-condition-tables-v1') return sequence;
  const { step_columns, step_rows, condition_columns, condition_rows } = sequence;
  if (![step_columns, step_rows, condition_columns, condition_rows].every(Array.isArray)
    || new Set(step_columns).size !== step_columns.length || new Set(condition_columns).size !== condition_columns.length
    || condition_rows.some(row => !Array.isArray(row) || row.length !== condition_columns.length)) throw Error('material_context_reference_invalid');
  return step_rows.map(row => {
    if (!Array.isArray(row) || row.length !== step_columns.length) throw Error('material_context_reference_invalid');
    return Object.fromEntries(step_columns.map((key, index) => {
      if (!['before', 'after'].includes(key)) return [key, row[index]];
      const state = condition_rows[row[index]];
      if (!Number.isInteger(row[index]) || !state) throw Error('material_context_reference_invalid');
      return [key, Object.fromEntries(condition_columns.map((field, position) => [field, state[position]]))];
    }));
  });
}

export function expandSharedMaterialTaskContexts(input) {
  const expanded = structuredClone(input), contexts = expanded.shared_task_contexts;
  if (contexts !== undefined && (!Array.isArray(contexts) || !Array.isArray(expanded.tasks)
    || new Set(contexts.map(row => row.context_id)).size !== contexts.length)
    ) throw Error('material_context_reference_invalid');
  for (const task of expanded.tasks ?? []) if (task.context_ref !== undefined) {
    if (!contexts) throw Error('material_context_reference_invalid');
    const matches = contexts.filter(row => row.context_id === task.context_ref);
    if (matches.length !== 1 || !matches[0].fields || Object.keys(matches[0].fields).some(key => !sharedMaterialContextFields.includes(key) || Object.hasOwn(task, key)))
      throw Error('material_context_reference_invalid');
    const fields = structuredClone(matches[0].fields);
    if (fields.story_sequence !== undefined) fields.story_sequence = decodeSharedStorySequence(fields.story_sequence);
    Object.assign(task, fields); delete task.context_ref;
  }
  delete expanded.shared_task_contexts;
  const metadata = expanded.shared_observation_metadata;
  if (metadata !== undefined) {
    if (!Array.isArray(metadata) || new Set(metadata.map(row => row.metadata_id)).size !== metadata.length)
      throw Error('material_observation_metadata_reference_invalid');
    for (const prediction of predictionsIn(expanded)) if (prediction.observation_metadata_ref !== undefined) {
      const matches = metadata.filter(row => row.metadata_id === prediction.observation_metadata_ref);
      if (matches.length !== 1 || Object.keys(matches[0].fields ?? {}).some(key => !observationMetadataFields.includes(key) || Object.hasOwn(prediction, key)))
        throw Error('material_observation_metadata_reference_invalid');
      Object.assign(prediction, matches[0].fields); delete prediction.observation_metadata_ref;
    }
    delete expanded.shared_observation_metadata;
  }
  return expanded;
}

function shareMaterialContexts(input) {
  const schema = input.schema ?? input.response_schema;
  if (!Array.isArray(input.tasks) || !schema?.properties?.decisions) return null;
  if (input.shared_task_contexts !== undefined || input.tasks.some(task => task.context_ref !== undefined))
    throw Error('material_context_reserved_field_in_input');
  const groups = new Map();
  for (const [index, task] of input.tasks.entries()) {
    const fields = Object.fromEntries(sharedMaterialContextFields.filter(key => Object.hasOwn(task, key)).map(key => [key, task[key]]));
    if (!Object.keys(fields).length) continue;
    const hash = canonical(fields), group = groups.get(hash) ?? { fields, indexes: [] };
    group.indexes.push(index); groups.set(hash, group);
  }
  const shared = [...groups.values()].filter(group => group.indexes.length > 1);
  if (!shared.length) return null;
  const output = structuredClone(input), rows = [];
  for (const group of shared) {
    const context_id = `material_context_${rows.length + 1}`;
    const fields = structuredClone(group.fields);
    if (fields.story_sequence !== undefined) fields.story_sequence = encodeSharedStorySequence(fields.story_sequence);
    rows.push({ context_id, fields });
    for (const index of group.indexes) {
      for (const key of Object.keys(group.fields)) delete output.tasks[index][key];
      output.tasks[index].context_ref = context_id;
    }
  }
  output.shared_task_contexts = rows;
  if (canonical(expandSharedMaterialTaskContexts(output)) !== canonical(input)) throw Error('material_context_roundtrip_changed');
  return { input: output, audit: { revision: sharedMaterialTaskContextRevision,
    original_tasks_sha256: shaBytes(canonical(input.tasks)), context_hashes: rows.map(row => ({ context_id: row.context_id,
      fields_sha256: shaBytes(canonical(row.fields)), task_ids: output.tasks.filter(task => task.context_ref === row.context_id).map(task => task.task_id ?? task.case_id) })),
    all_context_values_inline: true, original_input_reconstructed_equal: true, task_specific_fields_omitted: false } };
}

function shareObservationMetadata(input) {
  const schema = input.schema ?? input.response_schema;
  if (!Array.isArray(input.tasks) || !schema?.properties?.decisions) return null;
  if (input.shared_observation_metadata !== undefined || predictionsIn(input).some(row => row.observation_metadata_ref !== undefined))
    throw Error('material_observation_metadata_reserved_field_in_input');
  const output = structuredClone(input), groups = new Map();
  for (const row of predictionsIn(output)) {
    const fields = Object.fromEntries(observationMetadataFields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
    if (Object.keys(fields).length < 2) continue;
    const hash = canonical(fields), group = groups.get(hash) ?? { fields, predictions: [] };
    group.predictions.push(row); groups.set(hash, group);
  }
  const shared = [...groups.values()].filter(group => group.predictions.length > 1);
  if (!shared.length) return null;
  output.shared_observation_metadata = shared.map((group, index) => {
    const metadata_id = `observation_metadata_${index + 1}`;
    for (const row of group.predictions) {
      for (const key of Object.keys(group.fields)) delete row[key]; row.observation_metadata_ref = metadata_id;
    }
    return { metadata_id, fields: group.fields };
  });
  // Context sharing may already be present; check only this metadata transform.
  const hydrated = expandSharedMaterialTaskContexts(output), original = expandSharedMaterialTaskContexts(input);
  if (canonical(hydrated) !== canonical(original)) throw Error('material_observation_metadata_roundtrip_changed');
  return { input: output, audit: { revision: sharedMaterialTaskContextRevision,
    inline_metadata_hashes: output.shared_observation_metadata.map(row => ({ metadata_id: row.metadata_id,
      fields_sha256: shaBytes(canonical(row.fields)) })), all_raw_outputs_scores_clocks_and_unknowns_retained: true } };
}

// Repeated structures are submitted once. Expanded schemas remain the local
// validator, so compact transmission never weakens the caller's contract.
export function deduplicateBusinessSchema(schema) {
  const counts = new Map(), representatives = new Map();
  function collect(node, root = false) {
    if (!node || typeof node !== 'object') return;
    if (!Array.isArray(node) && !root && node.type !== undefined) {
      const key = canonical(node);
      if (key.length >= 160) { counts.set(key, (counts.get(key) ?? 0) + 1); representatives.set(key, node); }
    }
    if (node.properties) Object.values(node.properties).forEach(child => collect(child));
    if (node.items) collect(node.items);
  }
  collect(schema, true);
  const names = new Map([...counts].filter(([, n]) => n > 1).map(([key], i) => [key, `structure_${i}`]));
  function replace(node, root = false) {
    const name = !root && names.get(canonical(node));
    if (name) return { $ref: `#/$defs/${name}` };
    const result = structuredClone(node);
    if (result.properties) result.properties = Object.fromEntries(Object.entries(result.properties).map(([key, value]) => [key, replace(value)]));
    if (result.items) result.items = replace(result.items);
    return result;
  }
  const result = replace(schema, true);
  if (names.size) result.$defs = Object.fromEntries([...names].map(([key, name]) => [name, replace(representatives.get(key), true)]));
  return result;
}

export function compactBusinessShape(schema, { numericBounds = false } = {}) {
  function describe(node) {
    if (node.$ref) return node.$ref.split('/').at(-1);
    if (node.enum) return `enum(${node.enum.map(value => JSON.stringify(value)).join('|')})`;
    const kinds = Array.isArray(node.type) ? node.type : [node.type];
    if (kinds.includes('object')) return '{' + Object.entries(node.properties ?? {}).map(([key, value]) =>
      `${key}${node.required?.includes(key) ? '' : '?'}:${describe(value)}`).join(',') + '}' + (kinds.includes('null') ? '|null' : '');
    if (kinds.includes('array')) return `[${describe(node.items)}]` + (node.minItems !== undefined ? ` min=${node.minItems}` : '')
      + (node.maxItems !== undefined ? ` max=${node.maxItems}` : '') + (kinds.includes('null') ? '|null' : '');
    return kinds.map(type => ({ string: 'str', number: 'num', integer: 'int', boolean: 'bool' }[type] ?? type)).join('|')
      + (node.pattern ? ` pattern=${JSON.stringify(node.pattern)}` : '')
      + (numericBounds && node.minimum !== undefined ? ` minimum=${node.minimum}` : '')
      + (numericBounds && node.maximum !== undefined ? ` maximum=${node.maximum}` : '');
  }
  return 'Required fields have no ?, optional fields have ?. Objects reject extra keys. Arrays retain order. '
    + describe(schema) + '\n' + Object.entries(schema.$defs ?? {}).map(([key, value]) => `${key}=${describe(value)}`).join('\n');
}

export function projectCompactBusinessContract(input, { shareMaterialTaskContexts = true } = {}) {
  const assemblyDecision=projectAssemblyDecisionContract(input);
  const callerSchema = input.schema ?? input.response_schema, businessSchema = structuredClone(assemblyDecision?.schema??callerSchema), fixed = {};
  const candidates = { source_video_sha256: input.data?.source_video_sha256 ?? input.source_video_sha256,
    request_id: input.data?.request_id ?? input.request_id };
  for (const [key, value] of Object.entries(candidates)) if (value !== undefined && businessSchema.properties?.[key]) {
    validateSchema(value, callerSchema.properties[key], `host_${key}`); fixed[key] = value;
    delete businessSchema.properties[key]; businessSchema.required = (businessSchema.required ?? []).filter(item => item !== key);
  }
  if (businessSchema.properties?.schema_version?.enum?.length === 1) {
    fixed.schema_version = businessSchema.properties.schema_version.enum[0]; delete businessSchema.properties.schema_version;
    businessSchema.required = (businessSchema.required ?? []).filter(item => item !== 'schema_version');
  }
  const planSchema = businessSchema.properties?.plan, sourceWindowSchema = planSchema?.properties?.arcs?.items?.properties?.pieces?.items?.properties?.source_window;
  const assembly = input.stage === 'current_research_episode_assembly' && planSchema?.properties?.source_video_sha256 && sourceWindowSchema
    ? { sourceSha: input.data?.source_video_sha256, selected: ['music', 'words'].flatMap(kind => input.data?.candidates?.[kind] ?? []) } : null;
  if (assembly) {
    if (!/^[a-f0-9]{64}$/.test(assembly.sourceSha ?? '')) throw Error('assembly_host_source_identity_required');
    delete planSchema.properties.source_video_sha256;
    planSchema.required = planSchema.required.filter(key => key !== 'source_video_sha256');
    for (const key of ['asset_id', 'source_sha256', 'candidate_source_range']) delete sourceWindowSchema.properties[key];
    sourceWindowSchema.required = sourceWindowSchema.required.filter(key => !['asset_id', 'source_sha256', 'candidate_source_range'].includes(key));
  }
  // The model chooses uncertainty treatment and evidence IDs. Exact source
  // prose/identity/conditions are host data, not text the model should recopy.
  const disposition = businessSchema.properties?.uncertainty_dispositions?.items;
  const direction = input.data?.compact_direction_revision === compactDirectionRevision
    && disposition?.properties?.components?.items?.properties?.text
    ? { analysis: decodeTables(input.data.analysis), cue_context: input.data.cue_context ?? [],
      direction_uncertainties: input.data.direction_uncertainties ?? [], sourceSha: input.data.source_video_sha256 } : null;
  if (direction) {
    const scope = businessSchema.properties.uncertainty_scopes?.items?.properties;
    if (scope?.event_ids) scope.event_ids = { ...scope.event_ids,
      items: { type: 'string', enum: (direction.analysis?.sound_events ?? []).map(row => row.id) } };
    delete disposition.properties.original_text; delete disposition.properties.source_video_sha256;
    disposition.required = disposition.required.filter(key => !['original_text', 'source_video_sha256'].includes(key));
    const component = disposition.properties.components.items;
    delete component.anyOf; delete component.properties.text;
    component.properties.text_range = { type: ['array', 'null'], items: { type: 'integer' }, minItems: 2, maxItems: 2 };
    component.required = component.required.map(key => key === 'text' ? 'text_range' : key);
    const basis = component.properties.basis.items;
    delete basis.properties.quote; basis.required = basis.required.filter(key => key !== 'quote');
    basis.properties.story_beat_id = { ...basis.properties.story_beat_id,
      enum: (direction.analysis?.story_beats ?? []).map(row => row.id) };
    const condition = component.properties.condition_refs.items;
    for (const key of ['relationship', 'threat_resolved']) delete condition.properties[key];
    condition.required = condition.required.filter(key => !['relationship', 'threat_resolved'].includes(key));
  }
  const evidence = [], lookup = new Map();
  function project(value) {
    if (Array.isArray(value)) return value.map(project);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.path === 'string' && /^[a-f0-9]{64}$/.test(value.sha256 ?? '')) {
      const identity = canonical({ path: value.path, sha256: value.sha256 });
      if (!lookup.has(identity)) { const id = `bound_evidence_${evidence.length + 1}`; lookup.set(identity, id);
        evidence.push({ id, binding: { path: value.path, sha256: value.sha256 } }); }
      return { evidence_ref: lookup.get(identity), ...Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['path', 'sha256'].includes(key)).map(([key, item]) => [key, project(item)])) };
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['schema', 'response_schema'].includes(key)).map(([key, item]) => [key, project(item)]));
  }
  const consumer = input.stage === 'current_research_episode_assembly' ? projectAssemblyConsumerInput(input) : null;
  let baseInput = consumer?.input ?? input;
  if(assemblyDecision)baseInput=projectAssemblyDecisionInput(baseInput,assemblyDecision.context);
  if(assemblyDecision&&input.data?.actual_previous_assembly_tail){
    baseInput=structuredClone(baseInput);
    baseInput.data.bounded_assembly_continuation_revision=boundedAssemblyContinuationRevision;
    bindActualTailOperandView(baseInput.data,[]);
    delete baseInput.data.bounded_assembly_continuation_revision;
  }
  const shared = shareMaterialTaskContexts ? shareMaterialContexts(baseInput) : null;
  const observationSharing = shareMaterialTaskContexts ? shareObservationMetadata(shared?.input ?? baseInput) : null;
  const projected = project(observationSharing?.input ?? shared?.input ?? baseInput);
  if (projected.data) for (const key of Object.keys(fixed)) delete projected.data[key];
  for (const key of Object.keys(fixed)) delete projected[key];
  const deduplicated = deduplicateBusinessSchema(businessSchema);
  projected.host_contract = { revision: compactBusinessRevision, fixed_fields_omitted_from_model_output: Object.keys(fixed),
    business_shape: compactBusinessShape(deduplicated),
    output_encoding: 'Return business_json containing the serialized business object matching business_shape. Do not return omitted host fields. Host parses and strictly validates the complete original schema and stage semantics.',
    evidence_ref_policy: 'Immutable host evidence bindings; source clocks, facts and selectable IDs remain in this input.' };
  if(assemblyDecision)projected.host_contract.assembly_decisions={revision:assemblyDecision.context.revision,instruction:assemblyDecision.instruction};
  if (shared) projected.host_contract.shared_task_contexts = { revision: sharedMaterialTaskContextRevision,
    instruction: 'Each task.context_ref inherits ALL literal fields from the matching shared_task_contexts context_id. Complete context is inline once. For shared-story-condition-tables-v1, step_rows map to step_columns in order; before/after integers index condition_rows, which map to condition_columns. Every original value, unknown and clock is retained. Task IDs/kinds/ranges, allowed words intervals, queries, presets and candidate observations remain task-specific. Expand before comparison; never merge music and lyrics decisions or omit either task.' };
  if (observationSharing) projected.host_contract.shared_observation_metadata = {
    instruction: 'Each prediction.observation_metadata_ref inherits the matching inline shared_observation_metadata fields. Per-window source_range, raw ASR/lyric text, parsed unknowns, all label probabilities and human-activity scores remain unchanged on each prediction. Shared false qualification flags never approve any candidate.' };
  if (assembly) projected.host_contract.assembly_source_bindings = { revision: researchAssemblyProjectionRevision,
    instruction: 'Omit plan.source_video_sha256 and source_window.asset_id/source_sha256/candidate_source_range. For each nonnull source_window choose ONLY segment_id and creative source_range. Host resolves exact asset/SHA/full candidate window using that selected segment AND the current arc.cue_id; different cue, unknown/ambiguous segment or guessed host fields are rejected. Null source_window keeps intentional silence; no new source is invented.' };
  if (direction) projected.host_contract.direction_output_refs = {
    revision: compactDirectionRevision,
    component_kind_stage_pairs: { evidence_gap: ['before_specific_edit'], narrative_constraint: ['persistent_narrative_constraint'],
      deferred_review: ['after_trial_render', 'persistent_provenance_limit'], pending_work: ['material_selection', 'words_selection'] },
    instruction: 'Within uncertainty_dispositions only, omit original_text/source_video_sha256, components.text, components.basis.quote, and components.condition_refs.relationship/threat_resolved; host restores these exact reference fields. Only condition_refs omit relationship/threat_resolved. All cues.case_conditions, cues.exclude_case_conditions and cues.story_sequence.before/after still REQUIRE relationship and threat_resolved with their typed values; the model judges these from actual plot evidence. text_range=null means the complete unchanged uncertainty; otherwise use [start,end) Unicode character offsets. Ordered component ranges must exactly cover the complete original sentence without overlaps/gaps. Mixed matters must remain separately classified when necessary. event_ids are SOUND EVENT IDs only; story beat IDs belong to basis/boundary_events. Empty event_ids is allowed except original_sound; original_mix must have []. Do not use copied/paraphrased uncertainties or invent evidence. All unknown reasons remain intact. Keep reason and retained_constraints brief; they are judgments, not approval.'
  };
  const wireSchema = { type: 'object', properties: { business_json: { type: 'string' } }, required: ['business_json'], additionalProperties: false };
  return { input: projected, callerSchema, businessSchema, wireSchema, fixed, direction, assembly,assemblyDecision:assemblyDecision?.context??null,
    audit: { revision: compactBusinessRevision, full_input_sha256: shaBytes(canonical(input)),
      fixed_fields: fixed, evidence_bindings: evidence,
      ...(assemblyDecision?{assembly_decision_projection:assemblyDecision.audit}:{}),
      ...(shared ? { material_task_context_projection: shared.audit } : {}),
      ...(observationSharing ? { material_observation_metadata_projection: observationSharing.audit } : {}),
      ...(assembly ? { assembly_output_projection: { revision: researchAssemblyProjectionRevision,
        source_identity_host_bound: true, selected_source_sha256: shaBytes(canonical(assembly.selected)), creative_ranges_unchanged: true } } : {}),
      ...(consumer ? { assembly_consumer_projection: consumer.audit } : {}),
      ...(direction ? { direction_output_projection: { revision: compactDirectionRevision,
        analysis_identity: shaBytes(canonical(direction.analysis)), literal_values_host_bound: true } } : {}),
      source_clocks_or_facts_rewritten: false,
      qualified: false, production_approval: false } };
}

export function restoreCompactBusinessValue(value, contract, options = {}) {
  validateSchema(value, contract.wireSchema);
  const businessValue = JSON.parse(value.business_json);
  validateSchema(businessValue, contract.businessSchema);
  const restored = contract.assemblyDecision?restoreAssemblyDecisionValue(businessValue,contract.assemblyDecision):{ ...businessValue, ...contract.fixed };
  if (contract.assembly) {
    restored.plan.source_video_sha256 = contract.assembly.sourceSha;
    for (const arc of restored.plan.arcs) for (const piece of arc.pieces) if (piece.source_window !== null) {
      const source = piece.source_window;
      const matches = contract.assembly.selected.filter(candidate => candidate.segment_id === source.segment_id
        && (candidate.cue_id === arc.cue_id || candidate.parent_cue_id === arc.cue_id));
      if (matches.length !== 1) throw Error('assembly_selected_source_ambiguous_or_unknown_cue');
      const candidate = matches[0];
      if (typeof candidate.asset_id !== 'string' || !/^[a-f0-9]{64}$/.test(candidate.source_sha256 ?? '')
        || !Array.isArray(candidate.source_range) || candidate.source_range.length !== 2
        || candidate.source_range.some(value => !Number.isFinite(value)) || candidate.source_range[1] <= candidate.source_range[0])
        throw Error('assembly_selected_candidate_identity_invalid');
      source.asset_id = candidate.asset_id; source.source_sha256 = candidate.source_sha256;
      source.candidate_source_range = [...candidate.source_range];
    }
  }
  if (contract.direction) restoreDirectionRefs(restored, contract.direction, options);
  validateRestoredCompactBusinessValue(restored, contract); return restored;
}

// Historical requests already allowed unknown cue danger, but their host-owned
// condition references accidentally retained a boolean-only schema. Keep those
// immutable requests readable without changing any model-owned field or value.
export function validateRestoredCompactBusinessValue(value, contract) {
  const nullRefs = (value.uncertainty_dispositions ?? []).flatMap(row => row.components ?? [])
    .flatMap(part => part.condition_refs ?? []).filter(ref => ref.threat_resolved === null);
  if (!contract.direction || !nullRefs.length) return validateSchema(value, contract.callerSchema);
  const cueSchema = contract.callerSchema.properties?.cues?.items?.properties?.case_conditions;
  const threatSchema = cueSchema?.properties?.threat_resolved;
  if (!Array.isArray(threatSchema?.type) || !threatSchema.type.includes('null'))
    return validateSchema(value, contract.callerSchema);
  for (const ref of nullRefs) {
    const cues = (value.cues ?? contract.direction.cue_context ?? []).filter(cue => cue.cue_id === ref.cue_id);
    if (cues.length !== 1 || cues[0].case_conditions?.threat_resolved !== null
      || cues[0].case_conditions.relationship !== ref.relationship)
      throw Error('compact_direction_condition_reference_invalid');
  }
  const schema = structuredClone(contract.callerSchema);
  const component = schema.properties?.uncertainty_dispositions?.items?.properties?.components?.items;
  for (const branch of [component, ...(component?.anyOf ?? [])]) {
    const fields = branch?.properties?.condition_refs?.items?.properties;
    const old = fields?.threat_resolved;
    if (old?.type === 'boolean' && Object.keys(old).length === 1)
      fields.threat_resolved = { type: ['boolean', 'null'] };
  }
  return validateSchema(value, schema);
}

function decodeTables(value) {
  if (!value) return value;
  const result = structuredClone(value);
  for (const key of ['story_beats', 'sound_events']) if (result[key] && !Array.isArray(result[key])) {
    const { columns, rows } = result[key];
    if (!Array.isArray(columns) || new Set(columns).size !== columns.length || !Array.isArray(rows)
      || rows.some(row => !Array.isArray(row) || row.length !== columns.length)) throw Error('compact_direction_analysis_table_invalid');
    result[key] = rows.map(row => Object.fromEntries(columns.map((column, index) => [column, row[index]])));
  }
  return result;
}

function restoreDirectionRefs(value, context, options = {}) {
  for (const disposition of value.uncertainty_dispositions) {
    const originals = disposition.origin === 'analysis' ? context.analysis?.uncertainties
      : value.uncertainties ?? context.direction_uncertainties;
    const original = originals?.[disposition.uncertainty_index];
    if (typeof original !== 'string' || !/^[a-f0-9]{64}$/.test(context.sourceSha ?? ''))
      throw Error('compact_direction_uncertainty_reference_invalid');
    disposition.original_text = original; disposition.source_video_sha256 = context.sourceSha;
    let end = 0, lastOriginalRange = null;
    const chars = Array.from(original);
    for (const component of disposition.components) {
      const range = component.text_range === null ? [0, chars.length] : component.text_range;
      if (!Array.isArray(range) || range.length !== 2 || range.some(n => !Number.isInteger(n))
        || range[0] !== end || range[1] <= range[0] || range[1] > chars.length)
        throw Error('compact_direction_component_range_invalid');
      component.text = chars.slice(...range).join(''); end = range[1]; lastOriginalRange = [...range]; delete component.text_range;
      for (const basis of component.basis) {
        const rows = context.analysis?.story_beats?.filter(row => row.id === basis.story_beat_id) ?? [];
        if (rows.length !== 1 || typeof rows[0][basis.field] !== 'string' || !rows[0][basis.field].trim())
          throw Error('compact_direction_basis_reference_invalid');
        basis.quote = rows[0][basis.field];
      }
      for (const ref of component.condition_refs) {
        const rows = (value.cues ?? context.cue_context).filter(row => row.cue_id === ref.cue_id);
        if (rows.length !== 1 || typeof rows[0].case_conditions?.relationship !== 'string'
          || (rows[0].case_conditions.threat_resolved !== null
            && typeof rows[0].case_conditions.threat_resolved !== 'boolean')) throw Error('compact_direction_condition_reference_invalid');
        ref.relationship = rows[0].case_conditions.relationship; ref.threat_resolved = rows[0].case_conditions.threat_resolved;
      }
    }
    if (end !== chars.length) {
      // This explicit host reconstruction only restores one original terminal
      // U+3002 after every lexical character has already been covered. It never
      // changes the model's component classification or repairs a middle gap.
      if (options.terminalFullStopRecovery !== directionTerminalFullStopRecoveryRevision
        || !Array.isArray(options.encodingAudit) || end !== chars.length - 1
        || chars[end] !== '。' || !lastOriginalRange || !disposition.components.length)
        throw Error('compact_direction_component_range_invalid');
      disposition.components.at(-1).text += chars[end];
      options.encodingAudit.push({revision:directionTerminalFullStopRecoveryRevision,
        source_video_sha256:context.sourceSha,origin:disposition.origin,uncertainty_index:disposition.uncertainty_index,
        component_index:disposition.components.length-1,original_text_sha256:shaBytes(original),
        original_range:lastOriginalRange,reconstructed_range:[lastOriginalRange[0],chars.length],
        appended_original_character:chars[end],semantic_classification_changed:false});
      end=chars.length;
    }
  }
}
