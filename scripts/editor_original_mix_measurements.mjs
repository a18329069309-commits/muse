import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { measureEditorSourceWindows, editorSourceMeasurementRevision } from './editor_source_window_measurements.mjs';

export const editorOriginalMixMeasurementRevision = 'original_mix_target_level_context_v1';
const RATE = 48000, MAX_FRAMES = 180 * RATE, HALF_POINT = RATE / 20;
const frame = seconds => Math.round(seconds * RATE);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw Error('editor_original_mix_' + reason); };
const execFileAsync = promisify(execFile);

function checkSource(source) {
  if (!path.isAbsolute(source?.path ?? '') || !/^[a-f0-9]{64}$/i.test(source?.sha256 ?? ''))
    fail('real_source_binding_required');
  return { path: path.resolve(source.path), sha256: source.sha256 };
}

// Source and target clocks must both start at zero. This function creates level
// probes only; it does not create music cues, sound assets or audible approvals.
export function buildOriginalMixMeasurementWindows({ source, music = [], sounds = [], durationSeconds,
  sourceClock = { sample_rate: RATE, target_offset_seconds: 0 } }) {
  const bound = checkSource(source), durationFrames = frame(durationSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isSafeInteger(durationFrames)
    || durationFrames <= 0 || sourceClock?.sample_rate !== RATE || sourceClock?.target_offset_seconds !== 0)
    fail('zero_start_48k_clock_required');
  if (!Array.isArray(music) || !Array.isArray(sounds) || music.length + sounds.length > 128)
    fail('bounded_requested_windows_required');
  const rows = [], ids = new Set();
  const add = (type, id, owner, start, end, requested, anchor = null, clipped = false) => {
    const key = `${type}:${id}`;
    if (ids.has(key)) fail('duplicate_event_or_cue_id');
    ids.add(key);
    let index = 0;
    for (let at = start; at < end; at += MAX_FRAMES) {
      const until = Math.min(end, at + MAX_FRAMES);
      const measurementId = `${key}:${index++}`;
      rows.push({ measurement_id: measurementId, measurement_scope: type,
        cue_id: owner.cue_id ?? null, parent_cue_id: owner.parent_cue_id ?? null, event_id: owner.event_id ?? null,
        requested_target_range: requested, target_anchor_seconds: anchor,
        target_range: [at / RATE, until / RATE], decoded_frames: until - at,
        clipped_at_source_boundary: clipped,
        candidate: { local_path: bound.path, source_sha256: bound.sha256,
          source_range: [at / RATE, until / RATE], segment_id: measurementId,
          cue_id: owner.cue_id ?? null, event_id: owner.event_id ?? null } });
    }
  };
  for (const cue of music) {
    const range = cue?.target_range;
    if (typeof cue?.cue_id !== 'string' || !cue.cue_id.trim() || !Array.isArray(range)
      || range.length !== 2 || !range.every(Number.isFinite)
      || range[0] < 0 || frame(range[1]) > durationFrames || frame(range[1]) <= frame(range[0]))
      fail('valid_existing_music_target_range_required');
    add('music_target_window', cue.cue_id, cue, frame(range[0]), frame(range[1]), [...range]);
  }
  for (const sound of sounds) {
    const seconds = sound?.target_anchor_seconds, at = frame(seconds);
    if (typeof sound?.event_id !== 'string' || !sound.event_id.trim() || !Number.isFinite(seconds)
      || seconds < 0 || at > durationFrames) fail('valid_existing_sound_anchor_required');
    const start = Math.max(0, at - HALF_POINT), end = Math.min(durationFrames, at + HALF_POINT);
    if (start >= end) fail('positive_point_window_required');
    add('point_sound_competing_window', sound.event_id, sound, start, end,
      [Math.max(0, seconds - .05), Math.min(durationSeconds, seconds + .05)], at / RATE,
      start !== at - HALF_POINT || end !== at + HALF_POINT);
  }
  if (rows.length === 0) fail('existing_target_windows_required');
  if (rows.length > 256) fail('expanded_window_limit_exceeded');
  return rows;
}

async function checkBudget(trialBudget, stage) {
  if (typeof trialBudget?.inspectLocal !== 'function') fail('shared_episode_budget_required');
  const budget = await trialBudget.inspectLocal({ stage });
  if (!Number.isFinite(budget?.remaining_ms) || budget.remaining_ms <= 0)
    fail('no_remaining_episode_time');
  return budget;
}

export async function measureEditorOriginalMixWindows({ source, parentSource = null, music = [], sounds = [],
  durationSeconds, sourceClock = { sample_rate: RATE, target_offset_seconds: 0 }, outputDir, trialBudget }) {
  if (!path.isAbsolute(outputDir ?? '')) fail('absolute_output_directory_required');
  const original = checkSource(source), parent = parentSource ? checkSource(parentSource) : null;
  const rows = buildOriginalMixMeasurementWindows({ source: original, music, sounds, durationSeconds, sourceClock });
  const budget = await checkBudget(trialBudget, 'editor_original_mix_measurement_preparation');
  await verifyEvidenceBindings([original, ...(parent ? [parent] : [])]);
  const ffmpeg = await execFileAsync('ffmpeg', ['-version'], { windowsHide: true,
    timeout: Math.max(1, Math.min(5000, Math.floor(budget.remaining_ms))), maxBuffer: 65536 });
  const identity = { revision: editorOriginalMixMeasurementRevision,
    wrapper_sha256: await hashFile(fileURLToPath(import.meta.url)), source: original, parent_source: parent,
    worker_revision: editorSourceMeasurementRevision,
    worker_sha256: await hashFile(fileURLToPath(new URL('./editor_source_window_measurements.mjs', import.meta.url))),
    ffmpeg_version_sha256: createHash('sha256').update(ffmpeg.stdout).digest('hex'),
    sample_rate: RATE, channels: 2, target_offset_seconds: 0, duration_frames: frame(durationSeconds),
    windows: rows.map(({ candidate, ...row }) => row) };
  const directory = path.join(outputDir, digest(identity)), receiptPath = path.join(directory, 'receipt.json');
  await mkdir(directory, { recursive: true });
  let cached;
  try { cached = await readJson(receiptPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (cached) {
    if (!same(cached.identity, identity)) fail('cached_identity_changed');
    await verifyEvidenceBindings([cached.measurements, cached.worker_measurements, original, ...(parent ? [parent] : [])]);
    const value = await readJson(cached.measurements.path);
    if (!same(value.identity, identity)) fail('cached_measurements_changed');
    await checkBudget(trialBudget, 'editor_original_mix_measurement_cache_return');
    return { ...value, binding: cached.measurements, reused: true };
  }
  // The existing public worker's "sounds" slot is a generic PCM-window decoder.
  // It does not classify sound; this wrapper explicitly assigns original_mix.
  const measured = await measureEditorSourceWindows({ sounds: rows.map(row => row.candidate),
    outputDir: path.join(directory, 'pcm-worker') });
  await verifyEvidenceBindings([original, ...(parent ? [parent] : [])]);
  await checkBudget(trialBudget, 'editor_original_mix_measurement_publish');
  if (measured.measurements.length !== rows.length) fail('worker_window_count_changed');
  const value = { schema_version: 1, kind: editorOriginalMixMeasurementRevision, role: 'original_mix', identity,
    worker_measurement: measured.binding, actual_pcm_decoded: true,
    actual_audio_listened: false, sound_facts_qualified: false, dramatic_effect_verified: false,
    production_approval: false, source_derivation_verified_by_wrapper: false,
    measurements: measured.measurements.map((measurement, i) => {
      const requested = rows[i];
      if (measurement.segment_id !== requested.measurement_id || measurement.source_sha256 !== original.sha256
        || !same(measurement.source_range, requested.target_range)
        || measurement.decoded_frames !== requested.decoded_frames) fail('worker_clock_or_source_changed');
      return { role: 'original_mix', ...identity.windows[i], source_sha256: original.sha256,
        pcm_sha256: measurement.pcm_sha256, rms_dbfs: measurement.rms_dbfs, peak_dbfs: measurement.peak_dbfs,
        technical_peak_target_seconds: measurement.technical_peak_source_seconds };
    }) };
  const binding = await saveJson(path.join(directory, 'measurements.json'), value);
  await saveJson(receiptPath, { identity, measurements: binding, worker_measurements: measured.binding });
  return { ...value, binding, reused: false };
}

export function compactEditorOriginalMixMeasurements(result) {
  return { revision: editorOriginalMixMeasurementRevision, role: 'original_mix', actual_measurement: result.binding,
    source: result.identity.source, parent_source: result.identity.parent_source,
    sample_rate: RATE, channels: 2, target_offset_seconds: 0,
    actual_audio_hearing: false, sound_facts_qualified: false, production_approval: false,
    rows: result.measurements.map(row => ({ role: 'original_mix', measurement_scope: row.measurement_scope,
      cue_id: row.cue_id, parent_cue_id: row.parent_cue_id, event_id: row.event_id, target_range: row.target_range,
      target_anchor_seconds: row.target_anchor_seconds, decoded_frames: row.decoded_frames,
      pcm_sha256: row.pcm_sha256, rms_dbfs: row.rms_dbfs, peak_dbfs: row.peak_dbfs,
      clipped_at_source_boundary: row.clipped_at_source_boundary })),
    limitations: ['RMS/peak measure the original combined mix, not separated dialogue, music or effect classes.',
      'A point-sound window is 100ms around its existing anchor, clipped only at original source boundaries.',
      'Use original levels as editing evidence; do not automatically raise gain, invent a cue or approve audibility.',
      'The host must establish derived audio/video correspondence; parent identity alone is not derivation proof.'] };
}
