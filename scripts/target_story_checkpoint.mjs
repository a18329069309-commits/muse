import path from 'node:path';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';
import { validateAnalysisResponse } from './analysis_bridge.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const fail = message => { throw Error(`target_analysis_checkpoint_${message}`); };
const bound = async value => {
  if (!path.isAbsolute(value?.path ?? '') || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) fail('explicit_binding_required');
  await verifyEvidenceBindings(value); return readJson(value.path);
};

// Import only a completed story stage, never the failed later composer or a different target's story.
export async function loadTargetStoryCheckpoint(checkpoint, prepared, { injected = false } = {}) {
  const names = ['compose_record', 'analysis_request', 'analysis', 'raw_response', 'original_request'];
  const docs = Object.fromEntries(await Promise.all(names.map(async name => [name, await bound(checkpoint[name])])));
  const prior = docs.compose_record, historic = prior.research_story, request = docs.analysis_request;
  if (prior.schema_version !== 1 || !['research', 'assisted_trial'].includes(prior.mode)
    || prior.source_video_sha256 !== prepared.source.sha256 || !historic
    || !prior.stages?.some(row => row.name === 'research_story_director' && row.status === 'completed'))
    fail('completed_same_source_story_required');
  for (const [key, field] of [['analysis_request', 'request'], ['analysis', 'analysis_result'],
    ['raw_response', 'response'], ['original_request', 'original_request']]) {
    if (!same(checkpoint[key], historic[field])) fail('original_stage_binding_mismatch');
  }
  await verifyEvidenceBindings(request.bindings);
  const manifest = request.bindings.find(row => row.kind === 'manifest');
  if (!manifest || request.source_video_sha256 !== prepared.source.sha256
    || request.timeline?.source_first_pts_seconds !== prepared.manifest.video.first_pts_seconds
    || request.timeline?.duration_samples !== prepared.manifest.timeline.duration_samples
    || request.timeline.sample_rate !== 48000 || request.timeline.zero_point !== 'first_visible_video_frame')
    fail('actual_source_clock_mismatch');
  const oldManifest = await readJson(manifest.path);
  if (oldManifest.analysis_window || oldManifest.source_sha256 !== prepared.source.sha256) fail('full_source_manifest_required');
  const frames = request.bindings.filter(row => row.kind === 'frame');
  if (frames.length !== prepared.prepared.frames.length || frames.some((frame, i) =>
    frame.sha256 !== prepared.prepared.frames[i].sha256
    || oldManifest.frames[i].timeline_seconds !== prepared.manifest.frames[i].timeline_seconds
    || oldManifest.frames[i].source_pts_seconds !== prepared.manifest.frames[i].source_pts_seconds))
    fail('actual_frame_contract_mismatch');
  const original = docs.original_request;
  if (original.data?.source_video_sha256 !== prepared.source.sha256
    || original.data?.request_id !== request.request_id || !same(original.data.timeline, request.timeline))
    fail('original_director_input_mismatch');
  await verifyEvidenceBindings(original.frames);
  const raw = docs.raw_response;
  if (!same(raw.value, docs.analysis)) fail('raw_story_value_mismatch');
  if (raw.execution_kind === 'deterministic_merge_of_bound_story_responses') {
    if (raw.source_video_sha256 !== prepared.source.sha256 || raw.facts_rewritten !== false
      || !raw.constituent_responses?.length || raw.actual_audio_processed !== false
      || raw.qualified !== false || raw.production_approval !== false) fail('actual_merged_story_evidence_required');
    await verifyEvidenceBindings([raw.constituent_responses, raw.frame_mapping]);
    for (const reference of raw.constituent_responses) {
      const part = await readJson(reference.path);
      if (part.execution_kind !== 'codex_cli_inference' || part.actual_runtime_executed !== true
        || part.actual_input_processed !== true || part.completion_status !== 'complete'
        || part.actual_audio_processed !== false || part.qualified !== false
        || part.source_video_sha256 !== prepared.source.sha256) fail('actual_constituent_execution_required');
    }
  } else if (!(injected && raw.execution_kind === 'injected_test_transport')) fail('supported_completed_execution_required');
  const check = await validateAnalysisResponse(checkpoint.analysis_request.path, checkpoint.analysis.path);
  if (!check.structure_valid || check.coverage_gaps.length) fail('actual_story_contract_invalid');
  return { value: docs.analysis, check, request, bindings: checkpoint,
    execution_kind: injected ? 'injected_test_transport' : 'reused_completed_bound_story',
    actual_analysis_performed: false, historical_analysis_reused: true };
}
