import { shaBytes, validateSchema } from './audio_api.mjs';
import { finitePartSchema } from './bounded_research_assembly.mjs';
import { motherActionUnits, projectMotherActionGroup, restoreMotherActionValue } from './bounded_mother_action_projection.mjs';
import { assemblyOwnedPartClockBoundsRevision, assemblyMotherActionEditingRevision } from './assembly_consumer_projection.mjs';
import {diagnosticAssemblySoundPrompt,assemblyObservedSoundPoolPrompt} from './assembly_consumer_projection.mjs';
import { projectCompactBusinessContract } from './compact_business_contract.mjs';
import { encodeBoundedInlineRecords, expandBoundedInlineRecords } from './bounded_inline_record_encoding.mjs';
import { assessIndependentMusicSupply } from './independent_music_supply.mjs';
import { assemblyGapContractRevision, assemblyGapPrompt } from './object_scoped_assembly_gaps.mjs';
import {assemblyDecisionContractRevision} from './assembly_decision_contract.mjs';

export const roleSplitAssemblyRevision = 'music-and-sound-editor-roles-v1';
export const assemblySourceCapacityRevision = 'admitted-continuous-source-capacity-v1';
const clone = structuredClone;
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const fail = detail => { throw Error(`role_split_assembly_${detail}`); };
const equal = (a, b) => canonical(a) === canonical(b);
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];
const sampleRange = range => range.map(value => Math.round(value * 48000));
const validRange = range => Array.isArray(range) && range.length === 2 && range.every(Number.isFinite)
  && range[0] >= 0 && Number.isSafeInteger(Math.round(range[1] * 48000))
  && Math.round(range[1] * 48000) > Math.round(range[0] * 48000);
const within = (inner, outer) => validRange(inner) && validRange(outer)
  && sampleRange(inner)[0] >= sampleRange(outer)[0] && sampleRange(inner)[1] <= sampleRange(outer)[1];
const asTable=value=>Array.isArray(value)?{columns:Object.keys(value[0]??{}),rows:value.map(row=>Object.values(row))}:value;

// Reuse the existing 48 kHz supply calculation for already admitted candidates.
// Permission groups remain separate; a union is information, never a new source
// window, a selected edit, or approval of hearing, lyric boundaries or purpose.
function sourceWindowCapacity(parent, prepared) {
  const revision = parent.data.assembly_source_capacity_revision;
  if (revision === undefined) return null;
  if (revision !== assemblySourceCapacityRevision) fail('source_capacity_revision_invalid');
  const groups = new Map();
  for (const candidate of prepared.data.candidates.music) {
    const cue = prepared.data.director.cues.find(row => row.cue_id === candidate.cue_id);
    const permissionTarget = candidate.allowed_target_range ?? cue?.target_range;
    const scoped=parent.data.assembly_decision_contract_revision===assemblyDecisionContractRevision;
    const target=scoped&&cue?[Math.max(permissionTarget[0],cue.target_range[0]),Math.min(permissionTarget[1],cue.target_range[1])]:permissionTarget;
    const binding = value => value?.path && /^[a-f0-9]{64}$/.test(value.sha256 ?? '');
    if (!cue || !within(target, cue.target_range) || !validRange(candidate.source_range)
      || !/^[a-f0-9]{64}$/.test(candidate.source_sha256 ?? '') || !candidate.asset_id
      || !binding(candidate.observation_record) || !binding(candidate.selection_record)
      || !parent.data.material_observations.some(row => row.segment_id === candidate.segment_id
        && row.source_sha256 === candidate.source_sha256 && equal(row.source_range, candidate.source_range)
        && equal(row.observation_record, candidate.observation_record))) fail('source_capacity_admitted_evidence_required');
    const ranges = candidate.selection_source_ranges ?? [candidate.source_range];
    if (!Array.isArray(ranges) || !ranges.length || ranges.some(range => !within(range, candidate.source_range)
      || candidate.library_allowed_source_range && !within(range, candidate.library_allowed_source_range)))
      fail('source_capacity_member_bounds_changed');
    const permissions = Object.fromEntries(['cue_id', 'parent_cue_id', 'allowed_target_range',
      'condition_binding', 'pack_id', 'music_pack_id', 'preset_id', 'route_kind',
      'library_allowed_source_range', 'source_facts_scope'].filter(key => Object.hasOwn(candidate, key))
      .map(key => [key, clone(candidate[key])]));
    const key = canonical([candidate.source_sha256, candidate.asset_id, permissions]);
    const group = groups.get(key) ?? { source_sha256: candidate.source_sha256,
      asset_id: candidate.asset_id, permissions, target_range: clone(target),
      ...(scoped?{permission_target_range:clone(permissionTarget)}:{}),members: [] };
    group.members.push({ segment_id: candidate.segment_id, source_range: clone(candidate.source_range),
      admitted_source_ranges: clone(ranges), observation_record: clone(candidate.observation_record),
      selection_record: clone(candidate.selection_record) });
    groups.set(key, group);
  }
  return { revision, sample_rate: 48000, scope: 'technical_admitted_window_union_only; edit_each_member_inside_its_own_bounds',
    groups: [...groups.values()].map(group => {
      // This adapter only enables the existing capacity calculator on the
      // parent's admitted evidence. No candidate readiness or approval changes.
      const supply = assessIndependentMusicSupply(group.members.flatMap(member => member.admitted_source_ranges.map(range => ({
        segment_id: member.segment_id, source_sha256: group.source_sha256, source_range: range,
        readiness: { decode_ready: true, observation_ready: true, edit_ready: true, diagnostic_selectable: true },
        offline_observation: member.observation_record }))), group.target_range);
      const recording = supply.recordings[0];
      return { ...group, source_ranges_samples: recording.source_ranges_samples,
        required_target_samples: supply.required_target_samples,
        max_contiguous_source_samples: supply.max_contiguous_recording_samples,
        single_contiguous_recording_available: supply.single_contiguous_recording_available };
    }), qualification_granted: false, lyric_boundaries_approved: false,
    artistic_approval: false, production_approval: false };
}

function completeConstraints(parent, decoded) {
  const scopes = decoded.director.uncertainty_scopes?.rows;
  if (!Array.isArray(scopes) || !Array.isArray(decoded.editing_constraints?.rows)) fail('complete_constraints_required');
  const proofs = [];
  const rows = decoded.editing_constraints.rows.map(([index, components]) => {
    const scope = scopes[index];
    if (!scope || !['analysis', 'direction'].includes(scope[0])) fail('uncertainty_scope_missing');
    const originals = scope[0] === 'analysis' ? parent.data.analysis.uncertainties : parent.data.director.uncertainties;
    const original = originals?.[scope[1]];
    const disposition = parent.data.director.uncertainty_dispositions.find(row => row.origin === scope[0]
      && row.uncertainty_index === scope[1]);
    if (typeof original !== 'string' || !disposition || disposition.original_text !== original
      || disposition.components.map(row => row.text).join('') !== original) fail('original_literal_changed');
    // Classification has already been validated upstream. Keep its full reason
    // in the audit; editors receive the literal and every executable constraint.
    proofs.push({ origin: scope[0], uncertainty_index: scope[1], disposition: clone(disposition), scope: clone(scope) });
    return [scope[0], scope[1], scope[2], original,
      components.map(row => [row[0], row[1], clone(row[3]), clone(row[4]), clone(row[5])])];
  });
  const count = parent.data.analysis.uncertainties.length + parent.data.director.uncertainties.length;
  if (rows.length !== count || new Set(rows.map(row => `${row[0]}/${row[1]}`)).size !== count)
    fail('complete_uncertainty_union_required');
  return { value: { columns: ['origin', 'uncertainty_index', 'impact', 'original_text', 'components'],
    component_columns: ['text_range', 'kind_stage_index', 'basis', 'condition_refs', 'retained_constraints'],
    kind_stage_pairs: clone(decoded.editing_constraints.kind_stage_pairs), rows }, proofs };
}

function schemaFor(parent, role, eventIds) {
  const schema = clone(parent.schema);
  if (role === 'music') {
    delete schema.properties.edits.properties.sounds;
    schema.properties.edits.required = schema.properties.edits.required.filter(key => key !== 'sounds');
  } else {
    delete schema.properties.plan;
    schema.required = schema.required.filter(key => key !== 'plan');
    const properties = schema.properties.edits.properties;
    schema.properties.edits.properties = { sounds: properties.sounds,
      ...(properties.schema_version ? { schema_version: properties.schema_version } : {}) };
    schema.properties.edits.required = schema.properties.edits.required.filter(key => ['sounds', 'schema_version'].includes(key));
    const sounds = schema.properties.edits.properties.sounds;
    sounds.minItems = eventIds.length; sounds.maxItems = eventIds.length;
    if (eventIds.length) sounds.items.properties.event_id = { ...sounds.items.properties.event_id, enum: eventIds };
  }
  if (parent.data.assembly_gap_contract_revision !== undefined) {
    if (parent.data.assembly_gap_contract_revision !== assemblyGapContractRevision
      || !schema.properties.gap_records?.items) fail('gap_contract_schema_required');
    const objects = gapRoleObjects(parent, role);
    schema.properties.gap_records.items.properties.object_kind.enum = Object.keys(objects);
    schema.properties.gap_records.items.properties.object_id.enum = [...new Set(Object.values(objects).flat())];
  }
  return schema;
}

function gapRoleObjects(parent, role) {
  const cues = parent.data.director.cues.filter(row => !row.context_only).map(row => row.cue_id);
  if (parent.data.mother_action_partition?.parent_cue_id) cues.push(parent.data.mother_action_partition.parent_cue_id);
  const candidates = role === 'music' ? [...parent.data.candidates.music, ...parent.data.candidates.words]
    : parent.data.candidates.sounds;
  return { episode: [parent.data.source_video_sha256],
    ...(role === 'music' ? { cue: [...new Set(cues)] } : { event: parent.data.analysis.sound_events.map(row => row.id) }),
    asset: [...new Set(candidates.flatMap(row => [row.asset_id, row.segment_id]).filter(Boolean))] };
}

function roleGapContext(parent, prepared, role) {
  if (parent.data.assembly_gap_contract_revision === undefined) return null;
  const context = parent.data.assembly_gap_context, objects = gapRoleObjects(role === 'music' ? prepared : parent, role);
  if (parent.data.assembly_gap_contract_revision !== assemblyGapContractRevision
    || context?.revision !== assemblyGapContractRevision || context.source_video_sha256 !== parent.data.source_video_sha256)
    fail('gap_contract_context_required');
  return { ...clone(context), known_objects: objects,
    words_requests: role === 'music' ? clone(context.words_requests) : [],
    word_explorations: role === 'music' ? clone(context.word_explorations) : [] };
}

export function projectRoleSplitAssemblyInputs(parent,{musicActionGroups,musicActionRange}={}) {
  if(musicActionGroups){
    if(parent.data?.assembly_decision_contract_revision!==assemblyDecisionContractRevision)fail('explicit_decision_groups_required');
    const units=motherActionUnits(parent);let next=0;
    if(!Array.isArray(musicActionGroups)||musicActionGroups.length!==2)fail('two_complete_action_groups_required');
    for(const group of musicActionGroups){if(!Array.isArray(group)||group.length!==2||group[0]!==next
      ||!Number.isInteger(group[1])||group[1]<=next||group[1]>units.actions.length)fail('two_complete_action_groups_required');next=group[1];}
    if(next!==units.actions.length)fail('two_complete_action_groups_required');
    const full=projectRoleSplitAssemblyInputs(parent);
    const parts=musicActionGroups.map(range=>projectRoleSplitAssemblyInputs(parent,{musicActionRange:range}).parts[0]);
    return {...full,parts:[...parts,full.parts[1]],music_action_groups:clone(musicActionGroups)};
  }
  if (parent?.stage !== 'current_research_episode_assembly' || !/^[a-f0-9]{64}$/.test(parent.data?.source_video_sha256 ?? '')
    || !parent.data.full_input?.path || !/^[a-f0-9]{64}$/.test(parent.data.full_input.sha256 ?? '')) fail('bound_parent_required');
  const units = motherActionUnits(parent);
  const prepared = projectMotherActionGroup({ ...clone(parent), schema: finitePartSchema(parent.schema) },...(musicActionRange??[0,units.actions.length]));
  if (prepared.input.data.assembly_consumer_projection_revision !== assemblyOwnedPartClockBoundsRevision)
    prepared.input.data.assembly_consumer_projection_revision = assemblyMotherActionEditingRevision;
  const contract = projectCompactBusinessContract(prepared.input);
  const decoded = expandBoundedInlineRecords(contract.input.data.inline);
  decoded.analysis.story_beats=asTable(decoded.analysis.story_beats);
  decoded.director.music_actions=asTable(decoded.director.music_actions);
  const constraints = completeConstraints(parent, decoded);
  const musicIds = new Set(decoded.candidates.music.map(row => row.segment_id));
  const soundIds = new Set(decoded.candidates.sounds.map(row => row.segment_id));
  const selectedEvents = new Set(decoded.candidates.sounds.map(row => row.event_id));
  const allEvents = parent.data.analysis.sound_events.map(row => row.id);
  const selectedEventRows = parent.data.analysis.sound_events.filter(row => selectedEvents.has(row.id));
  const selectedRanges = selectedEventRows.map(row => [row.start_seconds, row.end_seconds]);
  const common = () => ({ timeline: clone(decoded.timeline), editing_constraints: clone(constraints.value),
    actual_audio_hearing_approved: false });
  const music = { ...common(), director: clone(decoded.director),
    analysis_beat_clocks: { columns: ['id', 'start_seconds', 'end_seconds'], rows: decoded.analysis.story_beats.rows.map(row => row.slice(0, 3)) },
    measured_source_levels: clone(decoded.measured_source_levels),
    editor_source_measurements: { ...clone(decoded.editor_source_measurements),
      rows: decoded.editor_source_measurements.rows.filter(row => musicIds.has(row.segment_id)) },
    editor_original_mix_measurements: { ...clone(decoded.editor_original_mix_measurements),
      rows: decoded.editor_original_mix_measurements.rows.filter(row => row.cue_id) },
    material_observations: decoded.material_observations.filter(row => musicIds.has(row.segment_id)) };
  const fullCapacity = sourceWindowCapacity(parent, prepared.input);
  const capacity = fullCapacity && { ...fullCapacity, groups: fullCapacity.groups.map(group => ({
    source_sha256: group.source_sha256, asset_id: group.asset_id,
    permission_sha256: shaBytes(canonical(group.permissions)),
    target_range: group.target_range,...(group.permission_target_range?{permission_target_range:clone(group.permission_target_range)}:{}),source_ranges_samples: group.source_ranges_samples,
    required_target_samples: group.required_target_samples,
    max_contiguous_source_samples: group.max_contiguous_source_samples,
    single_contiguous_recording_available: group.single_contiguous_recording_available,
    members: group.members.map(({ observation_record, selection_record, ...member }) => member) })) };
  if (capacity) music.source_window_capacity = capacity;
  if(musicActionRange)music.context_only_parent_action_route=clone(parent.data.director.music_actions);
  delete music.director.sound_queries; delete music.director.uncertainty_scopes;
  const actionColumns = music.director.music_actions.columns;
  const actionBeat = actionColumns.indexOf('story_beat_id'), actionRange = actionColumns.indexOf('target_range');
  const reconstructedClocks = music.director.music_actions.rows.map(row => [row[actionBeat], ...row[actionRange]]);
  const beatClocksDerived = actionBeat >= 0 && actionRange >= 0
    && equal(reconstructedClocks, music.analysis_beat_clocks.rows);
  if (beatClocksDerived) {
    delete music.analysis_beat_clocks;
    music.analysis_beat_clocks_from_music_actions = true;
  }
  const sounds = { ...common(), diagnostic_sound_adoption_policy: clone(decoded.diagnostic_sound_adoption_policy),
    ...(decoded.assembly_sfx_pool_contract_revision?{assembly_sfx_pool_contract_revision:decoded.assembly_sfx_pool_contract_revision}:{}),
    sfx_event_function_revision: decoded.sfx_event_function_revision,
    sound_edit_decision_contract_revision: decoded.sound_edit_decision_contract_revision,
    director: { global_route_summary: decoded.director.global_route_summary,
      cue_conditions: decoded.director.cues.map(row => ({ cue_id: row.cue_id, case_conditions: clone(row.case_conditions),
        ...(row.exclude_case_conditions ? { exclude_case_conditions: clone(row.exclude_case_conditions) } : {}) })),
      sound_queries: parent.data.director.sound_queries.filter(row => selectedEvents.has(row.event_id)) },
    selected_event_context: { story_beats: { ...clone(decoded.analysis.story_beats),
      rows: decoded.analysis.story_beats.rows.filter(row => selectedRanges.some(range => overlap([row[1], row[2]], range))) },
      sound_events: clone(selectedEventRows) },
    candidates: { sounds: clone(decoded.candidates.sounds) },
    material_observations: decoded.material_observations.filter(row => soundIds.has(row.segment_id)),
    editor_source_measurements: { ...clone(decoded.editor_source_measurements),
      rows: decoded.editor_source_measurements.rows.filter(row => soundIds.has(row.segment_id)) },
    editor_original_mix_measurements: { ...clone(decoded.editor_original_mix_measurements),
      rows: decoded.editor_original_mix_measurements.rows.filter(row => selectedEvents.has(row.event_id)) },
    unselected_events: parent.data.analysis.sound_events.filter(row => !selectedEvents.has(row.id)).map(row => ({
      event_id: row.id, role: row.role, target_range: [row.start_seconds, row.end_seconds],
      original_decision: row.decision, reason: row.reason, supplied_candidate: false, gap_not_resolved: row.decision === 'seek_asset' })) };
  const parentHash = shaBytes(canonical(parent));
  const parentBinding = clone(parent.data.full_input);
  const parts = [['music', music], ['sounds', sounds]].map(([role, view]) => {
    const gapContext = roleGapContext(parent, prepared.input, role);
    if (gapContext) view.assembly_gap_context = gapContext;
    const candidates = role === 'music' ? { music: prepared.input.data.candidates.music.map(row => Object.fromEntries([
      'segment_id', 'asset_id', 'source_sha256', 'source_range', 'selection_source_ranges', 'allowed_target_range', 'cue_id', 'condition_binding'
    ].filter(key => Object.hasOwn(row, key)).map(key => [key, clone(row[key])]))), words: clone(prepared.input.data.candidates.words) } : {};
    const inline = encodeBoundedInlineRecords(view);
    if (!equal(expandBoundedInlineRecords(inline), view)) fail('inline_roundtrip_changed');
    const input = { stage: parent.stage, schema: schemaFor(role === 'music' ? prepared.input : parent, role, allEvents),
      prompt: role === 'music'
        ? 'Music only. Follow full route/constraints; no invented sources, loops or approval. Task=cue_id/arc/arc_id/piece_id; envelope dB is relative.'
          + (capacity ? ' source_window_capacity=48kHz union of same-recording, same-permission windows. Use real pieces within each member bounds; never invent a union candidate, extend, loop or bridge holes. This is capacity, not hearing/lyric/purpose approval.' : '')
        : 'Sound only: one decision/owned event. Obey full constraints, supplied ranges/anchors and original mix risks. No music edits, invented physical facts or approval. Unselected seek_asset gaps stay unresolved. '+diagnosticAssemblySoundPrompt
          +(decoded.assembly_sfx_pool_contract_revision?' '+assemblyObservedSoundPoolPrompt:''),
      data: { source_video_sha256: parent.data.source_video_sha256, candidates,
        ...(parent.data.assembly_decision_contract_revision?{assembly_decision_contract_revision:parent.data.assembly_decision_contract_revision}:{}),
        ...(gapContext ? { assembly_gap_contract_revision: assemblyGapContractRevision } : {}),
        assembly_partition: { revision: roleSplitAssemblyRevision, role, full_parent: parentBinding,
          owned_ids: role === 'music' ? prepared.action_ids : allEvents },
        encoding_instruction: 'Expand ~ rows from shapes; ~s from strings. All unknowns/constraints bind.', inline }, frames: [] };
    const part = { role, input, audit: { revision: roleSplitAssemblyRevision, parent_input_sha256: parentHash,
      full_parent: parentBinding, role, parent_projection: clone(prepared.mother_action_partition),
      source_video_sha256: parent.data.source_video_sha256, complete_active_unknown_count: constraints.value.rows.length,
      ...(role === 'music' && fullCapacity ? { source_capacity_admitted_evidence: fullCapacity } : {}),
      original_literal_roundtrip_equal: true, parent_disposition_reason_proof: clone(constraints.proofs),
      parent_business_projection_audit: clone(contract.audit), projection_roundtrip_equal: true,
      beat_clock_exact_derivation: role === 'music' && beatClocksDerived,
      fields_not_resubmitted: [
        { field: 'analysis.story_beats prose/style_direction', consumed_by: 'completed story/director stages',
          retained_here: role === 'music' ? 'complete current route/actions/beat clocks/active literals' : 'selected event beat context/active literals' },
        { field: 'analysis.original_audio observation prose', consumed_by: 'completed story stage',
          retained_here: 'all active original-mix literals, unchanged PCM measurement limitations and false qualification' },
        { field: 'uncertainty classification reasons', consumed_by: 'completed direction uncertainty classification',
          retained_here: 'full audit, every original literal/kind/stage/basis/condition/executable constraint' },
        { field: role === 'music' ? 'sound candidates/observations/queries' : 'music candidates/observations/edit operations',
          consumed_by: role === 'music' ? 'sound editor' : 'music editor', retained_here: 'full parent binding; relevant target competition measurements' }
      ], model_calls: 0, qualified: false, artistic_approval: false, production_approval: false } };
    if (gapContext) input.prompt += assemblyGapPrompt;
    return part;
  });
  return { revision: roleSplitAssemblyRevision, parts, parent_input_sha256: parentHash,
    full_parent: parentBinding, new_model_calls: 0, qualification_granted: false };
}

export function mergeRoleSplitAssemblyValues(parts, parent) {
  if(parts?.length===3&&parent.data?.assembly_decision_contract_revision===assemblyDecisionContractRevision)
    return mergeDecisionRoleGroups(parts,parent);
  if (!Array.isArray(parts) || parts.length !== 2 || new Set(parts.map(row => row.role)).size !== 2) fail('two_unique_roles_required');
  if (parts.some(row => row.audit?.parent_input_sha256 !== shaBytes(canonical(parent)))) fail('parent_or_projection_changed');
  const expected = projectRoleSplitAssemblyInputs(parent);
  for (const row of parts) {
    const part = expected.parts.find(part => part.role === row.role);
    if (!part || !equal(row.audit, part.audit)) fail('parent_or_projection_changed');
  }
  const music = parts.find(row => row.role === 'music').value, sounds = parts.find(row => row.role === 'sounds').value;
  if (!music?.plan || !music.edits || Object.hasOwn(music.edits, 'sounds') || sounds?.plan
    || !sounds?.edits || Object.keys(sounds.edits).some(key => !['sounds', 'schema_version'].includes(key))) fail('role_ownership_changed');
  const ids = parent.data.analysis.sound_events.map(row => row.id), actual = sounds.edits.sounds?.map(row => row.event_id);
  if (!Array.isArray(actual) || actual.length !== ids.length || new Set(actual).size !== ids.length
    || actual.some(id => !ids.includes(id))) fail('complete_sound_decisions_required');
  const restored = restoreMotherActionValue(clone(music), expected.parts[0].audit.parent_projection).value;
  restored.edits.sounds = clone(sounds.edits.sounds);
  restored.execution_gaps = [...(music.execution_gaps ?? []), ...(sounds.execution_gaps ?? [])];
  restored.review_pending = [...(music.review_pending ?? []), ...(sounds.review_pending ?? [])];
  if (parent.data.assembly_gap_contract_revision === assemblyGapContractRevision) {
    restored.gap_records = [];
    for (const [role, value] of [['music', music], ['sounds', sounds]]) {
      const part = expected.parts.find(row => row.role === role), records = value.gap_records;
      const gaps = value.execution_gaps ?? [], objects = gapRoleObjects(role === 'music'
        ? { ...parent, data: { ...parent.data, director: { ...parent.data.director,
          cues: [{ cue_id: part.audit.parent_projection.temporary_cue_id }] },
          mother_action_partition: { parent_cue_id: part.audit.parent_projection.parent_cue_id } } } : parent, role);
      if (!Array.isArray(records) || records.length !== gaps.length
        || new Set(records.map(row => row.gap_index)).size !== gaps.length) fail('role_gap_index_union_required');
      for (const record of records) {
        validateSchema(record, part.input.schema.properties.gap_records.items, 'role_split_gap_record');
        if (!gaps[record.gap_index] || !objects[record.object_kind]?.includes(record.object_id)) fail('role_gap_ownership_changed');
        const next = clone(record);
        if (role === 'music' && next.object_kind === 'cue'
          && next.object_id === part.audit.parent_projection.temporary_cue_id)
          next.object_id = part.audit.parent_projection.parent_cue_id;
        if (role === 'sounds') next.gap_index += music.execution_gaps?.length ?? 0;
        restored.gap_records.push(next);
      }
    }
  }
  return restored;
}

function mergeDecisionRoleGroups(parts,parent){
 if(parts.map(p=>p.role).join(',')!=='music,music,sounds')fail('role_group_order_changed');
 const groups=parts.slice(0,2).map(p=>[p.audit?.parent_projection?.action_start,p.audit?.parent_projection?.action_end]);
 const expected=projectRoleSplitAssemblyInputs(parent,{musicActionGroups:groups});
 for(const [i,part]of parts.entries())if(!equal(part.audit,expected.parts[i].audit))fail('parent_or_projection_changed');
 const restored=[];
 for(const part of parts.slice(0,2)){
  const value=part.value,p=part.audit.parent_projection;
  if(!value?.plan||!value.edits||Object.hasOwn(value.edits,'sounds'))fail('role_ownership_changed');
  const actual=value.edits.action_responses?.map(a=>a.action_id);
  if(!Array.isArray(actual)||new Set(actual).size!==p.owned_action_ids.length||actual.length!==p.owned_action_ids.length
   ||actual.some(id=>!p.owned_action_ids.includes(id)))fail('action_ownership_changed');
  if(value.plan.arcs.flatMap(a=>a.pieces).some(piece=>!within(piece.target_range,p.target_range)))fail('piece_target_ownership_changed');
  restored.push(restoreMotherActionValue(value,p).value);
 }
 const sound=parts[2].value,ids=parent.data.analysis.sound_events.map(e=>e.id),actual=sound?.edits?.sounds?.map(e=>e.event_id);
 if(sound?.plan||!sound?.edits||Object.keys(sound.edits).some(k=>!['sounds','schema_version'].includes(k)))fail('role_ownership_changed');
 if(!actual||actual.length!==ids.length||new Set(actual).size!==ids.length||actual.some(id=>!ids.includes(id)))fail('complete_sound_decisions_required');
 if(restored[0].edits.dialogue_ducking_db!==restored[1].edits.dialogue_ducking_db)fail('global_ducking_changed');
 const result={plan:{...restored[0].plan,arcs:[{...restored[0].plan.arcs[0],pieces:restored.flatMap(v=>v.plan.arcs[0].pieces)}]},
  edits:{...restored[0].edits,music_edits:restored.flatMap(v=>v.edits.music_edits),action_responses:restored.flatMap(v=>v.edits.action_responses),sounds:clone(sound.edits.sounds)},
  execution_gaps:parts.flatMap(p=>p.value.execution_gaps??[]),review_pending:parts.flatMap(p=>p.value.review_pending??[])};
 if(parent.data.assembly_gap_contract_revision===assemblyGapContractRevision){
  result.gap_records=[];let offset=0;
  for(const [i,part]of parts.entries()){
   const value=part.value,records=value.gap_records,gaps=value.execution_gaps??[],schema=expected.parts[i].input.schema.properties.gap_records.items;
   if(!Array.isArray(records)||records.length!==gaps.length||new Set(records.map(r=>r.gap_index)).size!==gaps.length)fail('role_gap_index_union_required');
   for(const record of records){validateSchema(record,schema,'role_split_gap_record');
    if(!Number.isInteger(record.gap_index)||record.gap_index<0||record.gap_index>=gaps.length)fail('role_gap_index_union_required');
    const objects=expandBoundedInlineRecords(expected.parts[i].input.data.inline).assembly_gap_context.known_objects;
    if(!objects[record.object_kind]?.includes(record.object_id))fail('role_gap_ownership_changed');
    const next=clone(record);
    if(part.role==='music'&&next.object_kind==='cue'&&next.object_id===part.audit.parent_projection.temporary_cue_id)
     next.object_id=part.audit.parent_projection.parent_cue_id;
    next.gap_index+=offset;result.gap_records.push(next);
   }offset+=gaps.length;
  }
 }
 return result;
}
