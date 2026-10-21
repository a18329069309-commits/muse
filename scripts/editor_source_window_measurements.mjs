import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

export const editorSourceMeasurementRevision = 'exact_selected_source_pcm_editor_context_v1';
const RATE = 48000, CHANNELS = 2, FRAME_BYTES = CHANNELS * 4;
const sample = seconds => Math.round(seconds * RATE);
const db = value => value > 0 ? Math.max(-120, 20 * Math.log10(value)) : -120;
const rounded = value => Math.round(value * 100) / 100;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = reason => { throw Error('editor_source_measurement_' + reason); };

function checkWindow(row) {
  const range = row.source_range;
  if (!path.isAbsolute(row.local_path ?? '') || !/^[a-f0-9]{64}$/i.test(row.source_sha256 ?? '')
    || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
    || range[0] < 0 || sample(range[1]) <= sample(range[0]) || range[1] - range[0] > 180)
    fail('exact_real_candidate_window_required');
  return [sample(range[0]), sample(range[1])];
}

function windowAccumulator(candidate, kind) {
  const [start, end] = checkWindow(candidate), frames = end - start;
  // At most 48 bins per source. These are energy measurements, never phrase labels.
  const binFrames = Math.max(Math.round(.5 * RATE), Math.ceil(frames / 48 / (RATE / 2)) * (RATE / 2));
  const bins = [];
  for (let at = start; at < end; at += binFrames) bins.push({ start: at, end: Math.min(end, at + binFrames),
    square: 0, peak: 0, samples: 0 });
  return { candidate, kind, start, end, frames, bins, square: 0, peak: 0, peakAt: start,
    samples: 0, hash: createHash('sha256') };
}

async function decodeGroup(source, windows) {
  await verifyEvidenceBindings(source);
  await new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', ['-v', 'error', '-nostdin', '-i', source.path,
      '-map', '0:a:0', '-ar', String(RATE), '-ac', String(CHANNELS), '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, shell: false });
    let carry = Buffer.alloc(0), position = 0, failure = null, stderr = '';
    child.stdout.on('data', chunk => {
      try {
        const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const usable = bytes.length - bytes.length % FRAME_BYTES, count = usable / FRAME_BYTES;
        for (const row of windows) {
          const from = Math.max(position, row.start), to = Math.min(position + count, row.end);
          if (from >= to) continue;
          const selected = bytes.subarray((from - position) * FRAME_BYTES, (to - position) * FRAME_BYTES);
          row.hash.update(selected);
          for (let at = from; at < to; at++) {
            const offset = (at - position) * FRAME_BYTES;
            const bin = row.bins[Math.floor((at - row.start) / (row.bins[0].end - row.bins[0].start))];
            for (let channel = 0; channel < CHANNELS; channel++) {
              const value = bytes.readFloatLE(offset + channel * 4), absolute = Math.abs(value);
              if (!Number.isFinite(value)) fail('nonfinite_actual_pcm');
              row.square += value * value; row.samples++;
              bin.square += value * value; bin.samples++; bin.peak = Math.max(bin.peak, absolute);
              if (absolute > row.peak) { row.peak = absolute; row.peakAt = at; }
            }
          }
        }
        position += count; carry = Buffer.from(bytes.subarray(usable));
      } catch (error) { failure = error; child.kill(); }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1500); });
    child.on('error', reject);
    child.on('close', code => {
      if (failure) return reject(failure);
      if (code !== 0 || carry.length) return reject(Error('editor_source_measurement_decode_failed: ' + stderr));
      if (windows.some(row => row.samples !== row.frames * CHANNELS)) return reject(Error('editor_source_measurement_incomplete_decoded_source'));
      resolve();
    });
  });
  await verifyEvidenceBindings(source);
}

function finish(row) {
  const bins = row.bins.map(bin => ({ source_range: [bin.start / RATE, bin.end / RATE],
    rms_dbfs: rounded(db(Math.sqrt(bin.square / bin.samples))), peak_dbfs: rounded(db(bin.peak)) }));
  return { kind: row.kind, cue_id: row.candidate.cue_id ?? null, event_id: row.candidate.event_id ?? null,
    segment_id: row.candidate.segment_id, source_sha256: row.candidate.source_sha256,
    source_range: [row.start / RATE, row.end / RATE], decoded_frames: row.frames,
    pcm_sha256: row.hash.digest('hex'), rms_dbfs: rounded(db(Math.sqrt(row.square / row.samples))),
    peak_dbfs: rounded(db(row.peak)), technical_peak_source_seconds: row.peakAt / RATE,
    source_energy_bins: bins,
    scope: 'Exact selected source PCM; source times are absolute recording times. RMS/peak describe level only, not music phrase, orchestration, sound identity or dramatic suitability.' };
}

// Called by the host before real model editing. Sources are decoded once per SHA;
// no speech/music model is called and no source range is silently extended.
export async function measureEditorSourceWindows({ music = [], sounds = [], outputDir }) {
  if (!path.isAbsolute(outputDir ?? '')) fail('absolute_output_directory_required');
  const moduleSha = await hashFile(fileURLToPath(import.meta.url));
  const requested = [...music.map(candidate => ({ candidate, kind: 'music' })),
    ...sounds.map(candidate => ({ candidate, kind: 'sound' }))];
  requested.forEach(({ candidate }) => checkWindow(candidate));
  const identity = { revision: editorSourceMeasurementRevision, module_sha256: moduleSha,
    sample_rate: RATE, channels: CHANNELS, windows: requested.map(({ candidate, kind }) => ({
      kind, cue_id: candidate.cue_id ?? null, event_id: candidate.event_id ?? null,
      segment_id: candidate.segment_id, source: { path: path.resolve(candidate.local_path), sha256: candidate.source_sha256 },
      source_range: candidate.source_range })) };
  const directory = path.join(outputDir, digest(identity));
  await mkdir(directory, { recursive: true });
  const receiptPath = path.join(directory, 'receipt.json');
  let cached;
  try { cached = await readJson(receiptPath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (cached) {
    if (!same(cached.identity, identity)) fail('cached_identity_changed');
    await verifyEvidenceBindings([cached.measurements, ...identity.windows.map(row => row.source)]);
    const value = await readJson(cached.measurements.path);
    if (!same(value.identity, identity)) fail('cached_measurements_changed');
    return { ...value, binding: cached.measurements, reused: true };
  }
  const groups = new Map(), rows = requested.map(({ candidate, kind }) => windowAccumulator(candidate, kind));
  for (const row of rows) {
    const key = JSON.stringify([row.candidate.local_path, row.candidate.source_sha256]);
    if (!groups.has(key)) groups.set(key, { source: { path: path.resolve(row.candidate.local_path), sha256: row.candidate.source_sha256 }, rows: [] });
    groups.get(key).rows.push(row);
  }
  for (const { source, rows: sourceRows } of groups.values()) await decodeGroup(source, sourceRows);
  const value = { schema_version: 1, kind: editorSourceMeasurementRevision, identity,
    actual_pcm_decoded: true, measurements: rows.map(finish),
    actual_audio_listened: false, sound_facts_qualified: false, dramatic_effect_verified: false, production_approval: false };
  const binding = await saveJson(path.join(directory, 'measurements.json'), value);
  await saveJson(receiptPath, { schema_version: 1, identity, measurements: binding });
  return { ...value, binding, reused: false };
}

export function compactEditorSourceMeasurements(result) {
  return { revision: editorSourceMeasurementRevision, actual_measurement: result.binding,
    actual_audio_hearing: false, rows: result.measurements.map(row => ({
      kind: row.kind, cue_id: row.cue_id, event_id: row.event_id, segment_id: row.segment_id,
      source_sha256: row.source_sha256, source_range: row.source_range, decoded_frames: row.decoded_frames,
      rms_dbfs: row.rms_dbfs, peak_dbfs: row.peak_dbfs,
      technical_peak_source_seconds: row.technical_peak_source_seconds,
      source_energy_columns: ['source_start_seconds', 'source_end_seconds', 'rms_dbfs', 'peak_dbfs'],
      source_energy_rows: row.source_energy_bins.map(bin => [...bin.source_range, bin.rms_dbfs, bin.peak_dbfs]) })),
    limitations: ['Energy bins do not establish musical phrases, sung words, orchestration changes or scene fit.',
      'A technical peak does not approve a sound-event anchor. Preserve previously bound candidate anchors.',
      'Choose edit gains per exact adopted material, not one fixed negative gain for all music and sound effects.'] };
}
