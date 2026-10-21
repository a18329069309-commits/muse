import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import {verifyDiagnosticBedPlacement} from './diagnostic_bed_placement.mjs';

const run = promisify(execFile), implementation = fileURLToPath(import.meta.url);
const kind = 'decoded_waveform_transient_measurement';
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];

// Reuse FFmpeg and the catalogue's first-above-10%-peak/peak measurement.
// These are placement candidates, never proof of a heard attack or scene fit.
export async function measureDiagnosticSfxAnchor({ source, sourceRange, outputDir }) {
  if (!path.isAbsolute(source?.path ?? '') || !range(sourceRange) || !path.isAbsolute(outputDir ?? '')
    || sourceRange[1] - sourceRange[0] > 10) throw Error('diagnostic_sfx_measurement_input_invalid');
  await verifyEvidenceBindings(source); await mkdir(outputDir, { recursive: true });
  const decodedPath = path.join(outputDir, 'decoded-window.f32');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-i', source.path, '-ss', String(sourceRange[0]),
    '-t', String(sourceRange[1] - sourceRange[0]), '-vn', '-ar', '48000', '-ac', '1', '-f', 'f32le', decodedPath],
  { windowsHide: true, maxBuffer: 1024 * 1024 });
  const bytes = await readFile(decodedPath), count = bytes.length / 4;
  if (!Number.isInteger(count) || count < 1) throw Error('diagnostic_sfx_measurement_decoding_empty');
  let peak = 0, peakSample = 0;
  for (let index = 0; index < count; index++) {
    const value = Math.abs(bytes.readFloatLE(index * 4));
    if (!Number.isFinite(value)) throw Error('diagnostic_sfx_measurement_nonfinite_pcm');
    if (value > peak) { peak = value; peakSample = index; }
  }
  const anchors = [];
  if (peak >= .001) {
    let first = 0;
    while (first < count && Math.abs(bytes.readFloatLE(first * 4)) < peak * .1) first++;
    anchors.push({ basis: 'first_sample_above_10pct_peak', sample: first, seconds: sourceRange[0] + first / 48000 });
    if (peakSample !== first) anchors.push({ basis: 'peak_sample', sample: peakSample, seconds: sourceRange[0] + peakSample / 48000 });
  }
  await verifyEvidenceBindings(source);
  return saveJson(path.join(outputDir, 'measurement.json'), { schema_version: 1, kind,
    source_audio: source, source_sha256: source.sha256, source_range: sourceRange,
    decoded_audio: { path: decodedPath, sha256: await hashFile(decodedPath) },
    sample_rate: 48000, decoded_samples: count, peak_linear: peak, anchor_candidates: anchors,
    implementation: { path: implementation, sha256: await hashFile(implementation) },
    actual_audio_processed: true, actual_audio_listened: false, qualified: false, production_approval: false,
    auditory_anchor_approval: false, usage_approval: false,
    basis: 'measured_transient_not_perceptual_contact_or_scene_approval' });
}

export async function verifyDiagnosticSfxAnchor(candidate) {
  if(candidate.duration_role==='bed')return verifyDiagnosticBedPlacement(candidate);
  await verifyEvidenceBindings(candidate.source_anchor_evidence);
  const receipt = await readJson(candidate.source_anchor_evidence.path);
  if (receipt.kind !== kind || receipt.source_sha256 !== candidate.source_sha256
    || receipt.source_audio?.sha256 !== candidate.source_sha256
    || path.resolve(receipt.source_audio?.path ?? '') !== path.resolve(candidate.local_path)
    || !range(receipt.source_range) || !range(candidate.source_range)
    || candidate.source_range[0] < receipt.source_range[0] || candidate.source_range[1] > receipt.source_range[1]
    || receipt.actual_audio_processed !== true || receipt.actual_audio_listened !== false
    || receipt.production_approval !== false || receipt.auditory_anchor_approval !== false || receipt.usage_approval !== false
    || candidate.human_review_record || candidate.anchor_review_status !== 'measured_diagnostic_pending_audition'
    || !receipt.anchor_candidates?.some(row => row.seconds === candidate.source_anchor_seconds)
    || candidate.source_anchor_seconds < candidate.source_range[0] || candidate.source_anchor_seconds >= candidate.source_range[1])
    throw Error('diagnostic_sfx_measured_anchor_binding_invalid');
  await verifyEvidenceBindings(receipt); return receipt;
}
