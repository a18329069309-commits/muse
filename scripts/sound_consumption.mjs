import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { readJson, saveJson, verifyEvidenceBindings, verifyLocalAudioExecution } from './audio_api.mjs';

const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const inside = (inner, outer) => range(inner) && range(outer) && inner[0] >= outer[0] && inner[1] <= outer[1];
async function readBound(ref) {
  if (!ref?.path || !ref.sha256) throw new Error('sound_consumption_evidence_binding_required');
  await verifyEvidenceBindings(ref); return readJson(ref.path);
}

// A missing query is pending work, not evidence that an event needs an added sound.
export function auditSoundQueries(analysis, director) {
  if (!analysis.source_video_sha256 || director.source_video_sha256 !== analysis.source_video_sha256)
    throw new Error('sound_query_source_mismatch');
  const events = analysis.sound_events ?? [], queries = director.sound_queries ?? [];
  if (new Set(events.map(row => row.id)).size !== events.length) throw new Error('sound_query_duplicate_event');
  const byId = new Map(events.map(row => [row.id, row])), byQuery = new Map();
  for (const query of queries) {
    const event = byId.get(query.event_id);
    if (!event || event.decision !== 'seek_asset' || !query.text?.trim()
      || !['sfx', 'ambience'].includes(query.asset_kind) || byQuery.has(query.event_id)
      || (event.role === 'ambience' && query.asset_kind !== 'ambience'))
      throw new Error('sound_query_event_or_kind_invalid');
    byQuery.set(query.event_id, query);
  }
  return events.map(event => ({
    event_id: event.id, source_range: [event.start_seconds, event.end_seconds], role: event.role,
    decision: event.decision, reason: event.reason, evidence_ids: event.evidence_ids,
    query: byQuery.get(event.id) ?? null,
    state: event.decision === 'omit' ? 'explicit_omit_no_new_sound'
      : event.decision !== 'seek_asset' ? 'explicit_original_decision_pending_audit'
      : byQuery.has(event.id) ? 'query_ready_not_retrieved_or_selected' : 'missing_explicit_sound_query',
    original_status: 'not_audited', missing_sound_confirmed: false, production_approval: false,
  }));
}

// Prepare one explicit alternative. The caller supplies a nominal placement; no onset is invented here.
export async function prepareOptionalSoundTrial(config) {
  const base = await readBound(config.base_config), handoff = await readBound(config.material_handoff);
  const analysis = await readBound(base.analysis), director = await readBound(base.director);
  const manifest = await readBound(base.manifest);
  if (manifest.source_sha256 !== analysis.source_video_sha256) throw new Error('optional_sound_source_manifest_mismatch');
  await verifyEvidenceBindings({ path: manifest.source_video, sha256: manifest.source_sha256 });
  auditSoundQueries(analysis, director);
  const event = analysis.sound_events.find(row => row.id === config.event_id);
  if (!event || event.decision !== 'seek_asset'
    || !['physical', 'foley', 'dramatic', 'transition'].includes(event.role))
    throw new Error('optional_sound_current_event_required_ambience_separate');
  const selector = await readBound(handoff.selection), bound = await readBound(handoff.binding);
  const raw = await readBound(selector.raw_response), input = await readBound(selector.input);
  const cases = await readBound(selector.case_source);
  if (raw.actual_runtime_executed !== true || raw.completion_status !== 'complete'
    || raw.input_sha256 !== selector.input.sha256)
    throw new Error('optional_sound_actual_selector_required');
  const decisions = (raw.value?.decisions ?? []).filter(row => row.kind === 'sfx'
    && row.selected_segment_ids?.includes(config.segment_id));
  const matches = decisions.filter(row => bound.cases?.some(current => current.case_id === row.case_id
    && current.development_preset?.steps?.some(step => step.step_id === row.step_id
      && step.source_event_id === event.id)));
  if (matches.length !== 1 || !matches[0].adopt_reason?.trim())
    throw new Error('optional_sound_event_selection_required');
  const decision = matches[0], target = bound.cases.find(row => row.case_id === decision.case_id);
  if (target.source_role !== 'current_unscored_target_not_reference_success_case'
    || target.evidence?.source_video_sha256 !== analysis.source_video_sha256
    || !cases.cases?.some(row => row.case_id === target.case_id
      && row.evidence?.source_video_sha256 === analysis.source_video_sha256)
    || !input.tasks?.some(row => row.case_id === decision.case_id && row.step_id === decision.step_id
      && row.candidates?.some(candidate => candidate.segment_id === config.segment_id)))
    throw new Error('optional_sound_current_source_required');
  const pack = bound.sound_packs?.find(row => target.sound_pack_ids?.includes(row.sound_pack_id)
    && row.members?.some(member => member.segment_id === config.segment_id));
  const member = pack?.members.find(row => row.segment_id === config.segment_id);
  const source = [...(member?.listening_evidence?.files ?? []), ...(member?.binding_evidence ?? [])]
    .find(row => row.sha256 === member?.source_sha256);
  if (!source || !member?.listening_evidence?.observation_record)
    throw new Error('optional_sound_bound_source_and_observation_required');
  if (!input.tasks?.some(row => row.case_id === decision.case_id && row.step_id === decision.step_id && row.kind === 'sfx'
    && row.candidates?.some(candidate => candidate.segment_id === member.segment_id && candidate.asset_id === member.asset_id
      && candidate.source_sha256 === member.source_sha256 && inside(member.source_range, candidate.source_range))))
    throw new Error('optional_sound_requested_source_window_required');
  await verifyEvidenceBindings(source);
  const observed = await readBound(member.listening_evidence.observation_record);
  await verifyEvidenceBindings(observed);
  if (observed.protocol !== 'local_audio_model') throw new Error('optional_sound_local_execution_required');
  await verifyLocalAudioExecution(observed, observed);
  if (observed.actual_audio_processed !== true || observed.source_sha256 !== member.source_sha256
    || !inside(member.source_range, observed.source_range))
    throw new Error('optional_sound_actual_observation_required');
  const placement = config.placement;
  if (!placement || !inside(placement.source_range, member.source_range)
    || !Number.isFinite(placement.target_seconds) || !Number.isFinite(placement.gain_db)
    || !placement.anchor_evidence?.trim()
    || placement.target_seconds < event.start_seconds || placement.target_seconds >= event.end_seconds
    || !inside([placement.target_seconds, placement.target_seconds + placement.source_range[1] - placement.source_range[0]],
      base.trial_scope?.target_range)) throw new Error('optional_sound_explicit_placement_required');
  const edits = await readBound(base.edits), candidates = await readBound(base.candidates);
  const materials = await readBound(base.current_materials);
  if (edits.sounds?.length || candidates.sounds?.length || base.trial_scope?.kind !== 'music_only_window')
    throw new Error('optional_sound_music_only_base_required');
  const out = path.resolve(config.output_dir);
  try { if ((await readdir(out)).length) throw new Error('optional_sound_output_must_be_empty'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const mapping = await saveJson(path.join(out, 'selection-mapping.json'), {
    source_video_sha256: analysis.source_video_sha256,
    decisions: [{ event_id: event.id, selected_segment_id: member.segment_id,
      selected_source_range: member.source_range, reason: decision.adopt_reason }],
    selection_provenance: { selector_record: handoff.selection, raw_response: selector.raw_response,
      case_input: selector.case_source, input: selector.input, cli_receipts: selector.cli_receipts },
  });
  const pointer = { event_id: event.id, asset_id: member.asset_id, segment_id: member.segment_id,
    source_sha256: member.source_sha256, source_range: member.source_range, local_path: source.path,
    observation_record: member.listening_evidence.observation_record, selection_record: mapping,
    target_case_id: target.case_id, target_step_id: decision.step_id, sound_pack_id: pack.sound_pack_id };
  const variant = { ...base, output_dir: path.join(out, 'render'), allow_nominal_event_anchors: true,
    candidates: await saveJson(path.join(out, 'candidates.json'), { ...candidates, sounds: [pointer] }),
    edits: await saveJson(path.join(out, 'edits.json'), { ...edits, sounds: [{ ...placement,
      event_id: event.id, selected_segment_id: member.segment_id, decision: 'new_asset', original_status: 'unknown',
      source_anchor_seconds: placement.source_range[0], reason: 'Independent research candidate variant; original sound, onset and cleanliness remain unknown.' }] }),
    current_materials: await saveJson(path.join(out, 'current-materials.json'), { ...materials,
      cases: [...materials.cases.filter(row => row.case_id !== target.case_id), target],
      sound_packs: [...(materials.sound_packs ?? []).filter(row => row.sound_pack_id !== pack.sound_pack_id), pack] }),
    trial_scope: { kind: 'music_with_optional_sounds_window', target_range: base.trial_scope.target_range,
      excluded_sound_event_ids: analysis.sound_events.filter(row => row.id !== event.id).map(row => row.id),
      reason: 'Explicitly selected optional sound alternative; all other events remain pending or excluded for this diagnostic.' },
  };
  const ready = await saveJson(path.join(out, 'config.json'), variant);
  return saveJson(path.join(out, 'handoff.json'), { schema_version: 1, ready_config: ready,
    base_config: config.base_config, actual_material_handoff: config.material_handoff,
    event_id: event.id, selected_segment_id: member.segment_id, event_count: 1,
    sound_tail_seconds_after_event: Math.max(0, placement.target_seconds + placement.source_range[1]
      - placement.source_range[0] - event.end_seconds),
    actual_audio_processed: true, actual_render_executed: false, original_status: 'unknown',
    event_anchor_status: 'nominal_caller_supplied_time_not_verified_onset',
    clean_content_status: member.clean_content_status ?? 'unknown', formal_adoption_allowed: false,
    production_approval: false, unresolved: ['original_sound_not_audited', 'exact_onset_unverified',
      'sound_content_and_cleanliness_unverified', 'independent_listening_not_performed'] });
}
