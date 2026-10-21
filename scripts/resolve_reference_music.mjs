import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readJson, saveJson, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const execute = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));
export const referenceMusicRevision = 'decoded-sample-reference-windows-and-recording-controls-v3';
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const bound = value => typeof value?.path === 'string' && value.path.length > 0 && /^[a-f0-9]{64}$/.test(value.sha256 ?? '');
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameFile = (a, b) => bound(a) && bound(b) && path.resolve(a.path) === path.resolve(b.path) && a.sha256 === b.sha256;
const integer = value => Number.isInteger(value) && value >= 0;
const correlation = value => Number.isFinite(value) && value >= 0 && value <= 1.0001;
function controlSummary(assets, windows) {
  const shared = assets.filter(asset => windows.every(window => window.recording_candidates.some(match =>
    match.asset_id === asset.asset_id && match.sha256 === asset.sha256)));
  const ordered = windows.map(window => window.reference_range).sort((a, b) => a[0] - b[0]);
  return {
    neighboring_window_candidates: shared.map(asset => ({ asset_id: asset.asset_id, sha256: asset.sha256,
      mapped_offsets_seconds: windows.map(window => window.recording_candidates.find(match =>
        match.asset_id === asset.asset_id && match.sha256 === asset.sha256).reference_to_recording_offset_seconds) })),
    incorrect_candidate_control_available: new Set(assets.map(asset => asset.sha256)).size > 1,
    neighboring_window_control_available: ordered.some((window, index) => index > 0 && window[0] <= ordered[index - 1][1] + .1),
  };
}

function validateWindowReports(raw, comparison, query, bounds, assets) {
  const length = bounds[1] - bounds[0], byId = new Map(assets.map(asset => [asset.asset_id, asset]));
  if (raw.operation !== 'match' || raw.query_sha256 !== query.sha256 || !same(raw.query_source_range, [0, length])
    || !Array.isArray(raw.matches)) throw new Error('reference_music_match_input_mismatch');
  for (const match of raw.matches) {
    const asset = byId.get(match.asset_id), support = match.matched_query_support_seconds;
    if (!sameFile(match, asset) || !Number.isFinite(match.query_start_maps_to_source_seconds)
      || !integer(match.consistent_hash_count) || !integer(match.raw_shared_hash_count)
      || !range(support) || support[1] > length + .1
      || match.query_start_maps_to_source_seconds + support[0] < asset.source_range[0] - .1
      || match.query_start_maps_to_source_seconds + support[1] > asset.source_range[1] + .1)
      throw new Error('reference_music_match_candidate_mismatch');
  }
  if (comparison.operation !== 'candidate_recording_comparison' || comparison.query_sha256 !== query.sha256
    || !same(comparison.source_range, [0, length]) || comparison.identity_verified !== false
    || !Array.isArray(comparison.candidates) || comparison.candidates.length !== assets.length
    || new Set(comparison.candidates.map(item => item.asset_id)).size !== assets.length)
    throw new Error('reference_music_comparison_input_mismatch');
  for (const candidate of comparison.candidates) {
    const asset = byId.get(candidate.asset_id);
    if (!sameFile(candidate, asset) || !same(candidate.source_range, asset.source_range)
      || !Array.isArray(candidate.comparisons) || !candidate.comparisons.length)
      throw new Error('reference_music_comparison_candidate_mismatch');
    for (const item of candidate.comparisons) {
      if (item.status === 'no_query_variance') continue;
      if (item.status !== 'measured' || !correlation(item.best_absolute_ncc)
        || !(item.other_positions_abs_p99 === null || correlation(item.other_positions_abs_p99))
        || !integer(item.independent_background_positions)
        || !Number.isFinite(item.query_start_maps_to_source_seconds) || !Number.isFinite(item.query_end_maps_to_source_seconds)
        || item.query_start_maps_to_source_seconds < asset.source_range[0] - .05
        || item.query_end_maps_to_source_seconds > asset.source_range[1] + .05
        || Math.abs(item.query_end_maps_to_source_seconds - item.query_start_maps_to_source_seconds - length) > .05)
        throw new Error('reference_music_comparison_measurement_invalid');
    }
  }
}

// Discovery and local comparison produce research evidence, never automatic adoption.
export async function referenceMusicInputs(inputFile) {
  const input = await bind(inputFile), spec = await readJson(input.path);
  if (spec.schema_version !== 1 || !bound(spec.reference_video) || !bound(spec.candidates)
    || !Array.isArray(spec.reference_windows) || !spec.reference_windows.length || spec.reference_windows.length > 3
    || new Set(spec.reference_windows.map(window => JSON.stringify(window))).size !== spec.reference_windows.length
    || spec.reference_windows.some(window => !range(window) || window[1] - window[0] > 10))
    throw new Error('reference_music_explicit_windows_required');
  await verifyEvidenceBindings([spec.reference_video, spec.candidates]);
  const document = await readJson(spec.candidates.path), assets = document.assets;
  if (!Array.isArray(assets) || !assets.length || assets.length > 20
    || new Set(assets.map(asset => asset.asset_id)).size !== assets.length
    || assets.some(asset => !bound(asset) || typeof asset.asset_id !== 'string' || !asset.asset_id.trim()
      || !range(asset.source_range) || asset.source_range[1] - asset.source_range[0] > 120
      || spec.reference_windows.some(window => window[1] - window[0] > asset.source_range[1] - asset.source_range[0])))
    throw new Error('reference_music_one_to_twenty_bounded_recordings_required');
  await verifyEvidenceBindings(assets.map(asset => ({ path: asset.path, sha256: asset.sha256 })));
  const tools = await Promise.all(['reference_fingerprint.py', 'compare_recording_windows.py',
    'upstream/UPSTREAM.json', 'upstream/LICENSE', 'upstream/audfprint_analyze.py', 'upstream/audfprint_match.py',
    'upstream/hash_table.py', 'upstream/audio_read.py', 'upstream/stft.py',
    'candidate_upstream/UPSTREAM.json', 'candidate_upstream/LICENSE', 'candidate_upstream/compare_candidate.py']
    .map(name => bind(path.join(here, 'reference_fingerprint', name))));
  const inputs = [input, spec.reference_video, spec.candidates, ...assets.map(asset => ({ path: asset.path, sha256: asset.sha256 })), ...tools];
  return { spec, assets, inputs, signature: shaBytes(JSON.stringify({ revision: referenceMusicRevision, inputs })) };
}

export async function validateReferenceMusicResult(result, prepared, { custom = false } = {}) {
  const { spec, assets, inputs } = prepared;
  if (result.schema_version !== 1 || result.revision !== referenceMusicRevision || result.signature !== prepared.signature
    || !sameFile(result.reference_video, spec.reference_video) || !same(result.inputs, inputs)
    || !same(result.case_ids, spec.case_ids ?? []) || !Array.isArray(result.windows)
    || !same(result.windows.map(window => window.reference_range), spec.reference_windows)
    || !Array.isArray(result.execution_receipts) || result.production_approval !== false
    || result.original_recording_identified !== false || result.fallback_performed !== false
    || result.lyrics_verified !== false || result.source_cleanliness !== 'unassessed'
    || typeof result.actual_runtime_executed !== 'boolean' || (custom && result.actual_runtime_executed))
    throw new Error('reference_music_result_binding_mismatch');
  await verifyEvidenceBindings([...inputs, ...result.execution_receipts,
    ...result.windows.flatMap(window => [window.query, window.provenance, window.fingerprint, window.comparison])]);
  for (const window of result.windows) {
    const provenance = await readJson(window.provenance.path), raw = await readJson(window.fingerprint.path);
    const comparison = await readJson(window.comparison.path), length = window.reference_range[1] - window.reference_range[0];
    if (!sameFile(provenance.input_video, spec.reference_video) || !same(provenance.input_range, window.reference_range)
      || !sameFile(provenance.output_audio, window.query) || !same(provenance.output_source_range, [0, length])
      || provenance.range_coordinate !== 'decoded_audio_zero_start_samples' || provenance.sample_rate !== 11025
      || !same(provenance.input_sample_range, window.reference_range.map(seconds => Math.round(seconds * 11025)))
      || provenance.actual_runtime_executed !== result.actual_runtime_executed)
      throw new Error('reference_music_extraction_input_mismatch');
    validateWindowReports(raw, comparison, window.query, window.reference_range, assets);
    if (!same(window.recording_candidates, raw.matches.map(match => ({ ...match,
      reference_to_recording_offset_seconds: match.query_start_maps_to_source_seconds - window.reference_range[0] }))))
      throw new Error('reference_music_candidate_result_mismatch');
  }
  const status = result.windows.some(window => window.recording_candidates.length)
    ? 'reference_music_lookup_pending_review' : 'reference_music_unresolved';
  if (result.status !== status) throw new Error('reference_music_result_status_mismatch');
  for (const [key, value] of Object.entries(controlSummary(assets, result.windows)))
    if (!same(result[key], value)) throw new Error('reference_music_controls_summary_mismatch');
  return result;
}

export async function resolveReferenceMusic(config, runtime = {}) {
  if (!config.input_file || !config.output_dir || !config.python) throw new Error('reference_music_input_output_python_required');
  const prepared = await referenceMusicInputs(config.input_file), { spec, inputs } = prepared;
  const output = path.resolve(config.output_dir);
  await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
  const run = runtime.execute ?? execute, receipts = [], windows = [];
  const ffmpegVersion = await run('ffmpeg', ['-version'], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const command = async (name, args, label) => {
    const started = performance.now();
    const result = await run(name, args, { windowsHide: true, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, timeout: 120000 });
    receipts.push(await saveJson(path.join(output, `${label}-execution.json`), {
      command: name, args, exit_code: 0, wall_seconds: (performance.now() - started) / 1000,
      stdout_sha256: shaBytes(result.stdout ?? ''), stderr_sha256: shaBytes(result.stderr ?? ''),
      execution_kind: runtime.execute ? 'injected_test_executor' : 'local_subprocess',
    }));
  };
  const fingerprint = path.join(here, 'reference_fingerprint', 'reference_fingerprint.py');
  const index = path.join(output, 'recordings.pklz');
  await command(config.python, ['-X', 'utf8', fingerprint, 'build', '--manifest', spec.candidates.path,
    '--index', index, '--out', path.join(output, 'index-build.json')], 'build');
  for (const [number, bounds] of spec.reference_windows.entries()) {
    const prefix = `window-${number + 1}`, clip = path.join(output, `${prefix}.wav`), length = bounds[1] - bounds[0];
    const sampleRange = bounds.map(seconds => Math.round(seconds * 11025));
    await command('ffmpeg', ['-nostdin', '-v', 'error', '-n', '-i', spec.reference_video.path,
      '-map', '0:a:0', '-ac', '1', '-af', `aresample=11025,atrim=start_sample=${sampleRange[0]}:end_sample=${sampleRange[1]},asetpts=PTS-STARTPTS`,
      '-ar', '11025', '-c:a', 'pcm_s16le', clip], `${prefix}-extract`);
    const query = await bind(clip), provenance = await saveJson(path.join(output, `${prefix}-provenance.json`), {
      schema_version: 1, operation: 'extract', actual_runtime_executed: !runtime.execute,
      input_video: spec.reference_video, input_range: bounds, output_audio: query, output_source_range: [0, length],
      range_coordinate: 'decoded_audio_zero_start_samples', sample_rate: 11025, input_sample_range: sampleRange,
      process: { exit_code: 0 }, tool: { name: 'ffmpeg', version: ffmpegVersion.stdout.split(/\r?\n/)[0] }, execution: receipts.at(-1),
    });
    const matchFile = path.join(output, `${prefix}-fingerprint.json`);
    await command(config.python, ['-X', 'utf8', fingerprint, 'match', '--index', index, '--query', clip,
      '--source-in-seconds', '0', '--source-out-seconds', String(length), '--out', matchFile], `${prefix}-match`);
    const compareFile = path.join(output, `${prefix}-comparison.json`);
    await command(config.python, ['-X', 'utf8', path.join(here, 'reference_fingerprint', 'compare_recording_windows.py'),
      '--query', clip, '--start', '0', '--end', String(length), '--candidates', spec.candidates.path, '--out', compareFile], `${prefix}-compare`);
    const raw = await readJson(matchFile), comparison = await readJson(compareFile);
    validateWindowReports(raw, comparison, query, bounds, prepared.assets);
    windows.push({ reference_range: bounds, query, provenance, fingerprint: await bind(matchFile), comparison: await bind(compareFile),
      recording_candidates: raw.matches.map(match => ({ ...match,
        reference_to_recording_offset_seconds: match.query_start_maps_to_source_seconds - bounds[0] })) });
  }
  await verifyEvidenceBindings(inputs);
  const result = {
    schema_version: 1, revision: referenceMusicRevision, signature: prepared.signature,
    status: windows.some(window => window.recording_candidates.length) ? 'reference_music_lookup_pending_review' : 'reference_music_unresolved',
    reference_video: spec.reference_video, case_ids: spec.case_ids ?? [], inputs, windows, execution_receipts: receipts,
    ...controlSummary(prepared.assets, windows),
    actual_runtime_executed: !runtime.execute, original_recording_identified: false,
    source_cleanliness: 'unassessed', lyrics_verified: false, production_approval: false,
    fallback_performed: false, paid_api_calls: 0,
    next_action: 'review_correct_and_wrong_recordings_neighbor_offsets_cleanliness_and_actual_source_windows',
  };
  await validateReferenceMusicResult(result, prepared);
  const artifact = await saveJson(path.join(output, 'reference-music-result.json'), result);
  return { ...result, artifact };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = await resolveReferenceMusic(await readJson(process.argv[2]));
  console.log(JSON.stringify({ status: result.status, artifact: result.artifact, windows: result.windows.length,
    original_recording_identified: false, production_approval: false }));
}
