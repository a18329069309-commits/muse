import { shaBytes } from './audio_api.mjs';
import { assemblySoundOwnershipRevision,withOwnedPartClockBounds,assemblyOwnedPartClockBoundsRevision,scopeAssemblySoundFunctionContext } from './assembly_consumer_projection.mjs';
import { motherActionPartitionRevision, prepareMotherActionAssemblyInputs } from './bounded_mother_action_projection.mjs';

export const boundedAssemblyProjectionRevision = 'ordered-mother-cue-scoped-assembly-v1';
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const clone = value => structuredClone(value);
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite) && value[0] >= 0 && value[1] > value[0];
const overlap = (a, b) => a[0] < b[1] && b[0] < a[1];
const identity = row => canonical([row.segment_id, row.source_sha256, row.source_range]);
const scopeKey = row => `${row.origin}/${row.uncertainty_index}`;
const belongs = (row, owned) => owned.has(row.cue_id) || owned.has(row.parent_cue_id)
  || typeof row.cue_id === 'string' && row.cue_id.endsWith('/words') && owned.has(row.cue_id.slice(0, -6));

function checkedInput(input) {
  const data = input?.data, cues = data?.director?.cues;
  if (input?.stage !== 'current_research_episode_assembly' || !/^[a-f0-9]{64}$/.test(data?.source_video_sha256 ?? '')
    || !Array.isArray(cues) || !cues.length || !Array.isArray(data.analysis?.story_beats)
    || !Array.isArray(data.analysis?.sound_events) || !Array.isArray(data.director.uncertainty_scopes)
    || !Array.isArray(data.director.uncertainty_dispositions) || !input.schema) throw Error('bounded_assembly_complete_input_required');
  const ids = new Set();
  for (const [index, cue] of cues.entries()) {
    if (typeof cue.cue_id !== 'string' || ids.has(cue.cue_id) || !range(cue.target_range)
      || index && cue.target_range[0] < cues[index - 1].target_range[1]) throw Error('bounded_assembly_ordered_nonoverlapping_mother_cues_required');
    ids.add(cue.cue_id);
  }
  for (const action of data.director.music_actions ?? []) {
    const owners = cues.filter(cue => (cue.required_action_ids ?? []).includes(action.id));
    if (owners.length !== 1 || !range(action.target_range) || action.target_range[0] < owners[0].target_range[0]
      || action.target_range[1] > owners[0].target_range[1]) throw Error('bounded_assembly_action_requires_single_complete_mother_cue');
  }
  for (const cue of cues) for (const id of cue.required_action_ids ?? []) if (!(data.director.music_actions ?? []).some(action => action.id === id))
    throw Error('bounded_assembly_required_action_missing');
  return data;
}

function sparseUncertainties(original, wanted) {
  return Object.fromEntries(Object.entries(original ?? []).filter(([index]) => wanted.has(Number(index))));
}

export function projectAssemblyCueGroup(fullInput, cueIds,{deferOwnedPartBounds=false}={}) {
  const source = checkedInput(fullInput), allCues = source.director.cues, owned = new Set(cueIds);
  const start = allCues.findIndex(cue => cue.cue_id === cueIds[0]);
  if (!cueIds.length || owned.size !== cueIds.length || start < 0
    || canonical(allCues.slice(start, start + cueIds.length).map(cue => cue.cue_id)) !== canonical(cueIds))
    throw Error('bounded_assembly_contiguous_cue_group_required');
  const cues = allCues.slice(start, start + cueIds.length), targetRange = [cues[0].target_range[0], cues.at(-1).target_range[1]];
  const events = source.analysis.sound_events;
  const ownerOfEvent = event => allCues.find(cue => event.start_seconds >= cue.target_range[0] && event.start_seconds < cue.target_range[1])?.cue_id;
  if (events.some(event => !ownerOfEvent(event))) throw Error('bounded_assembly_sound_event_owner_missing');
  const ownedEvents = new Set(events.filter(event => owned.has(ownerOfEvent(event))).map(event => event.id));
  const relevantEvents = new Set(events.filter(event => overlap([event.start_seconds, event.end_seconds], targetRange)).map(event => event.id));
  const scopes = source.director.uncertainty_scopes.filter(scope => {
    const cueRefs = scope.cue_ids ?? [], eventRefs = scope.event_ids ?? [];
    return !cueRefs.length && !eventRefs.length || cueRefs.some(id => owned.has(id)) || eventRefs.some(id => relevantEvents.has(id));
  });
  const scopeIds = new Set(scopes.map(scopeKey));
  const sourceScopes = new Set(source.director.uncertainty_scopes.map(scopeKey));
  const wanted = { analysis: new Set(), direction: new Set() };
  for (const scope of scopes) {
    if (!wanted[scope.origin]) throw Error('bounded_assembly_unknown_scope_origin');
    wanted[scope.origin].add(scope.uncertainty_index);
  }
  // Missing scope never means irrelevant: retain every such literal globally.
  for (const [origin, object] of [['analysis', source.analysis], ['direction', source.director]])
    for (const index of Object.keys(object.uncertainties ?? [])) if (!sourceScopes.has(`${origin}/${index}`)) wanted[origin].add(Number(index));
  const dispositions = source.director.uncertainty_dispositions.filter(row => scopeIds.has(scopeKey(row)) || !sourceScopes.has(scopeKey(row)));
  const beatIds = new Set(cues.flatMap(cue => cue.story_beat_ids ?? []));
  for (const beat of source.analysis.story_beats) if (overlap([beat.start_seconds, beat.end_seconds], targetRange)) beatIds.add(beat.id);
  const conditionCueIds = new Set();
  for (const disposition of dispositions) for (const component of disposition.components ?? []) {
    for (const basis of component.basis ?? []) beatIds.add(basis.story_beat_id);
    for (const ref of component.condition_refs ?? []) conditionCueIds.add(ref.cue_id);
  }
  const actionIds = new Set(cues.flatMap(cue => cue.required_action_ids ?? []));
  const actions = (source.director.music_actions ?? []).filter(action => actionIds.has(action.id));
  for (const action of actions) beatIds.add(action.story_beat_id);
  const input = clone(fullInput), data = input.data;
  data.analysis.story_beats = clone(source.analysis.story_beats.filter(beat => beatIds.has(beat.id)));
  data.analysis.sound_events = clone(events.filter(event => relevantEvents.has(event.id)));
  data.analysis.uncertainties = sparseUncertainties(source.analysis.uncertainties, wanted.analysis);
  data.director.cues = clone(cues);
  for (const cueId of conditionCueIds) if (!owned.has(cueId)) {
    const cue = allCues.find(row => row.cue_id === cueId);
    if (!cue) throw Error('bounded_assembly_condition_cue_missing');
    data.director.cues.push({ cue_id: cue.cue_id, case_conditions: clone(cue.case_conditions), context_only: true });
  }
  data.director.music_actions = clone(actions);
  data.director.sound_queries = clone((source.director.sound_queries ?? []).filter(query => relevantEvents.has(query.event_id)));
  data.director.uncertainties = sparseUncertainties(source.director.uncertainties, wanted.direction);
  data.director.uncertainty_scopes = clone(scopes);
  data.director.uncertainty_dispositions = clone(dispositions);
  data.candidates = { ...clone(source.candidates),
    music: clone((source.candidates?.music ?? []).filter(row => belongs(row, owned))),
    words: clone((source.candidates?.words ?? []).filter(row => belongs(row, owned))),
    sounds: clone((source.candidates?.sounds ?? []).filter(row => ownedEvents.has(row.event_id))) };
  const materialIds = new Set(['music', 'words', 'sounds'].flatMap(kind => data.candidates[kind]).map(identity));
  const observed = new Map();
  data.material_observations = [];
  for (const row of source.material_observations ?? []) if (materialIds.has(identity(row))) {
    const key = identity(row), previous = observed.get(key);
    if (previous && canonical(previous.observation) === canonical(row.observation)) continue;
    // A different observation/model is distinct evidence even for an identical recording window.
    observed.set(key, row); data.material_observations.push(clone(row));
  }
  if (source.measured_source_levels) data.measured_source_levels = clone(source.measured_source_levels.filter(row =>
    data.candidates.music.some(candidate => candidate.segment_id === row.segment_id && canonical(candidate.source_range) === canonical(row.source_range))));
  if (source.editor_source_measurements) {
    const sameSourceWindow = (candidate, row) => candidate.segment_id === row.segment_id
      && candidate.source_sha256 === row.source_sha256
      && candidate.source_range?.every((at, index) => Math.round(at * 48000) === Math.round(row.source_range?.[index] * 48000))
      && (row.cue_id === null || candidate.cue_id === row.cue_id)
      && (row.event_id === null || candidate.event_id === row.event_id);
    data.editor_source_measurements = clone(source.editor_source_measurements);
    data.editor_source_measurements.rows = clone(source.editor_source_measurements.rows.filter(row =>
      (row.kind === 'sound' ? data.candidates.sounds : data.candidates.music).some(candidate => sameSourceWindow(candidate, row))));
  }
  if(source.editor_original_mix_measurements?.rows){
    data.editor_original_mix_measurements=clone(source.editor_original_mix_measurements);
    data.editor_original_mix_measurements.rows=clone(source.editor_original_mix_measurements.rows.filter(row=>
      row.event_id?ownedEvents.has(row.event_id):owned.has(row.cue_id)||owned.has(row.parent_cue_id)));
  }
  if (source.sound_event_guidance) data.sound_event_guidance = clone(source.sound_event_guidance.filter(row => relevantEvents.has(row.event_id)));
  const route = allCues.map(cue => ({ cue_id: cue.cue_id, target_range: cue.target_range,
    relationship: cue.case_conditions?.relationship ?? null, threat_resolved: cue.case_conditions?.threat_resolved ?? null,
    function: cue.function, sound_goal: cue.sound_goal }));
  data.assembly_partition = { revision: boundedAssemblyProjectionRevision,
    full_input_sha256: shaBytes(canonical(fullInput)), owned_cue_ids: [...cueIds], owned_event_ids: [...ownedEvents],
    owned_action_ids: [...actionIds], target_range: targetRange, complete_episode_route: clone(route),
    original_unknown_indices_preserved: true, original_timebase_unchanged: true,
    instruction: 'Compose only owned_cue_ids/action_ids/events. Other cue rows are context only. The complete ordered route and global route summary remain authoritative. Unknowns use original index keys, not compacted indices; unscoped unknowns are global. Never resolve an unknown or edit another part.' };
  input.prompt += ' This is one consecutive mother-cue group of the same episode. Return only its owned arcs/action responses/sound decisions; keep all absolute clocks. Context-only cues and overlapping sounds owned elsewhere must not receive edits. Preserve all supplied pending constraints. Other groups are assembled separately, never assume their output.';
  const scoped=scopeAssemblySoundFunctionContext(fullInput,input);
  return { input:deferOwnedPartBounds?scoped:withOwnedPartClockBounds(scoped), cue_ids: [...cueIds], event_ids: [...ownedEvents], action_ids: [...actionIds], target_range: targetRange };
}

export function withActualPreviousAssemblyTail(partInput, tail) {
  if (!tail || tail.source_video_sha256 !== partInput.data?.source_video_sha256 || !tail.previous_part_response
    || typeof tail.previous_part_response.path !== 'string' || !/^[a-f0-9]{64}$/.test(tail.previous_part_response.sha256 ?? '')
    || !tail.piece || typeof tail.arc_id !== 'string' || typeof tail.cue_id !== 'string')
    throw Error('bounded_assembly_actual_previous_tail_required');
  const input = clone(partInput);
  input.data.actual_previous_assembly_tail = clone(tail);
  input.prompt += ' The supplied previous tail is the actual adopted previous response, not an unused alternative. Respect its exact source/target windows and actual fade when choosing the next entry; never rewrite the previous part.';
  return input;
}

export function prepareBoundedAssemblyInputs(fullInput, { estimateInputBudget, maxInputTokens = 16000,
  maxParts = 3, previousTailAllowanceTokens = 1600 } = {}) {
  const data = checkedInput(fullInput);
  if (typeof estimateInputBudget !== 'function' || !Number.isSafeInteger(maxInputTokens) || maxInputTokens <= 0
    || !Number.isSafeInteger(maxParts) || maxParts < 1 || !Number.isSafeInteger(previousTailAllowanceTokens)
    || previousTailAllowanceTokens < 0) throw Error('bounded_assembly_capacity_policy_required');
  if(data.bounded_assembly_projection_revision===motherActionPartitionRevision&&data.director.cues.length===1)
    return prepareMotherActionAssemblyInputs(fullInput,{estimateInputBudget,maxInputTokens,maxParts,previousTailAllowanceTokens});
  if(data.bounded_assembly_projection_revision!==undefined&&data.bounded_assembly_projection_revision!==motherActionPartitionRevision)
    throw Error('bounded_assembly_projection_revision_invalid');
  const cues = data.director.cues, cache = new Map(), failures = [];
  const part = (start, end) => {
    const key = `${start}/${end}`;
    if (cache.has(key)) return cache.get(key);
    const value = projectAssemblyCueGroup(fullInput, cues.slice(start, end).map(cue => cue.cue_id));
    // New submitted parts opt into the current editing view explicitly. Old
    // unmarked completed requests continue reconstructing the exact v1 view.
    if (value.input.data.assembly_consumer_projection_revision!==assemblyOwnedPartClockBoundsRevision
      &&fullInput.schema?.properties?.edits?.properties?.schema_version?.enum?.includes(2))
      value.input.data.assembly_consumer_projection_revision = assemblySoundOwnershipRevision;
    const soundsSchema = value.input.schema?.properties?.edits?.properties?.sounds;
    if (soundsSchema && [assemblySoundOwnershipRevision,assemblyOwnedPartClockBoundsRevision].includes(value.input.data.assembly_consumer_projection_revision)) {
      soundsSchema.minItems = value.event_ids.length;
      soundsSchema.maxItems = value.event_ids.length;
      if (value.event_ids.length) soundsSchema.items.properties.event_id = {
        ...soundsSchema.items.properties.event_id, enum: [...value.event_ids] };
    }
    const budget = estimateInputBudget(value.input), tokens = typeof budget === 'number' ? budget : budget?.submitted_input_tokens ?? budget?.estimated_tokens;
    if (!Number.isFinite(tokens) || tokens <= 0) throw Error('bounded_assembly_complete_capacity_estimate_required');
    const reservedTail = start ? previousTailAllowanceTokens : 0;
    const row = { ...value, input_budget: budget, estimated_tokens: tokens,
      reserved_previous_tail_tokens: reservedTail, fits: tokens + reservedTail <= maxInputTokens };
    cache.set(key, row); return row;
  };
  const search = (start, remaining) => {
    if (start === cues.length) return [];
    if (!remaining) return null;
    for (let end = cues.length; end > start; end--) {
      const current = part(start, end);
      if (!current.fits) continue;
      const rest = search(end, remaining - 1);
      if (rest) return [current, ...rest];
    }
    return null;
  };
  let parts = null;
  for (let count = 1; count <= maxParts; count++) if (parts = search(0, count)) break;
  if (!parts) {
    for (let index = 0; index < cues.length; index++) failures.push(part(index, index + 1));
    const error = Error(failures.some(row => !row.fits) ? 'bounded_assembly_single_mother_cue_exceeds_capacity' : 'bounded_assembly_partition_call_budget_exhausted');
    error.capacity_report = { revision: boundedAssemblyProjectionRevision, max_input_tokens: maxInputTokens,
      max_parts: maxParts, per_cue: failures.map(({ input, ...row }) => row),
      original_cues_or_clocks_split: false, new_calls: 0 };
    throw error;
  }
  return { parts: parts.map(({ fits, ...row }) => row), audit: { revision: boundedAssemblyProjectionRevision,
    full_input_sha256: shaBytes(canonical(fullInput)), part_count: parts.length, max_input_tokens: maxInputTokens,
    previous_tail_allowance_tokens: previousTailAllowanceTokens, final_tail_must_be_reestimated: true,
    source_clocks_changed: false, new_calls: 0, qualification_granted: false } };
}
