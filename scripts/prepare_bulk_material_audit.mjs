// Independent-source audit preparation: no fabricated case IDs, selection, or Ready.
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { prepareSpecialistCandidateWindow } from './prepare_specialist_candidate_batch.mjs';
import {validSpecialistDevice} from './specialist_cache_identity.mjs';

const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const execute = promisify(execFile);

export function decodedZeroTrimArguments(job, destination) {
  const [start, end] = job.source_window_seconds.map(seconds => Math.round(seconds * 16000));
  return ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', '-i', job.source_file, '-vn', '-ac', '1',
    '-af', `aresample=16000,asetpts=PTS-STARTPTS,atrim=start_sample=${start}:end_sample=${end},asetpts=PTS-STARTPTS`,
    '-ar', '16000', '-c:a', 'pcm_s16le', destination];
}

export function selectedAuditWindows(assets, segments, selected, limit = 8) {
  if (limit !== 8 || !Array.isArray(selected) || selected.length < 1 || selected.length > limit
    || new Set(selected).size !== selected.length) throw new Error('explicit_one_to_eight_unique_audit_windows_required');
  const byAsset = new Map(assets.map(row => [row.asset_id, row]));
  const bySegment = new Map(segments.map(row => [row.segment_id, row]));
  return selected.map(id => {
    const segment = bySegment.get(id), asset = byAsset.get(segment?.asset_id);
    const range = [segment?.source_start_seconds, segment?.source_end_seconds];
    if (!asset || asset.source_sha256 !== segment.source_sha256 || asset.full_song_acquired !== true
      || asset.Ready !== false || !asset.local_path || !range.every(Number.isFinite)
      || !(0 <= range[0] && range[0] < range[1] && range[1] - range[0] <= 30.000001)
      || segment.Ready !== false || segment.window_kind !== 'analysis_only_not_phrase')
      throw new Error('actual_full_recording_unqualified_analysis_window_required');
    return { asset, segment, range };
  });
}

export async function prepareBulkMaterialAudit(config) {
  await verifyEvidenceBindings([config.assets, config.segments, config.inventory, config.model_configs]);
  const assets = (await readJson(config.assets.path)).assets;
  const segments = (await readJson(config.segments.path)).segments;
  const selected = selectedAuditWindows(assets, segments, config.segment_ids);
  const output = path.resolve(config.output_dir); await mkdir(output, { recursive: false });
  const prepared = [], gaps = [], sources = new Map();
  for (const { asset, segment, range } of selected) {
    const source = { path: asset.local_path, sha256: asset.source_sha256 };
    if (!sources.has(source.sha256)) {
      await verifyEvidenceBindings([source, asset.decode_receipt, asset.acquisition_result]);
      const decoded = await readJson(asset.decode_receipt.path);
      if (decoded.actual_audio_processed !== true || decoded.source?.sha256 !== source.sha256
        || !(decoded.decoded_duration_seconds > 0)) throw new Error('actual_full_source_decode_binding_required');
      sources.set(source.sha256, { source, decoded_duration: decoded.decoded_duration_seconds,
        acquisition_result: asset.acquisition_result, decode_receipt: asset.decode_receipt });
    }
    if (range[1] > sources.get(source.sha256).decoded_duration)
      throw new Error('audit_window_outside_actual_decoded_source');
    const job = { id: 'audit-' + shaBytes(JSON.stringify([source.sha256, range])).slice(0, 24),
      source_file: source.path, source_sha256: source.sha256, source_window_seconds: range, segment_id: segment.segment_id };
    try {
      let extractionReceipt;
      const command = config.decode_protocol === 'decoded_zero_sample_trim' ? async (binary, args) => {
        const actualArgs = decodedZeroTrimArguments(job, args.at(-1));
        const begun = performance.now(), result = await execute(binary, actualArgs, { windowsHide: true });
        extractionReceipt = await saveJson(path.join(output, 'extractions', job.id + '.json'), {
          schema_version: 1, protocol: 'decoded_audio_zero_start_sample_trim_v1', source,
          source_range: range, sample_rate_hz: 16000, argv: [binary, ...actualArgs],
          actual_subprocess_executed: true, exit_code: 0, wall_seconds: (performance.now() - begun) / 1000,
          source_range_changed: false, silence_padding_applied: false });
        return result;
      } : undefined;
      const input = await prepareSpecialistCandidateWindow(job, path.join(output, 'inputs'), { ffmpeg: config.ffmpeg,
        ...(command ? { command } : {}) });
      prepared.push({ ...input, ...(extractionReceipt ? { extraction_receipt: extractionReceipt } : {}) });
    } catch (error) {
      if (error.message !== 'prepared_samples_do_not_cover_candidate_range') throw error;
      gaps.push({ segment_id: segment.segment_id, ...error.coverage, no_padding_or_range_rewrite: true });
    }
  }
  if (!prepared.length) throw new Error('no_actual_prepared_audit_windows');
  const modelConfigs = [];
  for (const reference of config.model_configs) {
    const template = await readJson(reference.path);
    if (!['qwen3_asr', 'panns_sed'].includes(template.backend) || !validSpecialistDevice(template.device))
      throw new Error('existing_specialist_template_required');
    modelConfigs.push(await saveJson(path.join(output, 'configs', template.backend + '.json'), {
      ...template, output_dir: path.join(output, template.backend),
      ...(template.backend === 'panns_sed' ? { array_dir: path.join(output, 'scores') } : {}), jobs: prepared }));
  }
  const acousticConfig = await saveJson(path.join(output, 'configs', 'acoustics.json'), {
    ...config.acoustic_model, output_dir: path.join(output, 'acoustics'), jobs: prepared });
  return saveJson(path.join(output, 'bulk-preparation.json'), { schema_version: 1,
    purpose: 'actual_independent_recording_batch_audit_not_user_film_trial', input_config: config.input_binding ?? null,
    assets: config.assets, segments: config.segments, inventory: config.inventory,
    selected_segment_ids: config.segment_ids, batch_size_limit: 8, jobs: prepared,
    sources: [...sources.values()], source_recordings: sources.size, configs: modelConfigs,
    acoustic_config: acousticConfig, gaps, actual_model_forwards_performed_by_preparation: 0,
    source_windows_are_phrases: false, original_case_use_verified_by_preparation: false,
    listening_qualification_granted: false, genre_verified: false, Ready: false, new_user_trial_created: false });
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('prepare_bulk_material_audit.mjs')) {
  const config = await readJson(process.argv[2]);
  const result = await prepareBulkMaterialAudit({ ...config, input_binding: await bound(process.argv[2]) });
  console.log(JSON.stringify(result));
}
