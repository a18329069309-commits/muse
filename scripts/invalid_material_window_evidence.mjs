import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, verifyEvidenceBindings, shaBytes } from './audio_api.mjs';

const execute = promisify(execFile);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = reason => { throw Error('invalid_material_window_' + reason); };
const validRange = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
function pcm(bytes) {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') fail('native_wav_required');
  let format, data;
  for (let at = 12; at + 8 <= bytes.length;) {
    const size = bytes.readUInt32LE(at + 4), id = bytes.toString('ascii', at, at + 4);
    if (at + 8 + size > bytes.length) fail('wav_chunk_truncated');
    if (id === 'fmt ') format = { code: bytes.readUInt16LE(at + 8), channels: bytes.readUInt16LE(at + 10),
      rate: bytes.readUInt32LE(at + 12), bits: bytes.readUInt16LE(at + 22) };
    if (id === 'data') { if (data) fail('duplicate_pcm_chunk'); data = bytes.subarray(at + 8, at + 8 + size); }
    at += 8 + size + size % 2;
  }
  if (format?.code !== 1 || format.channels !== 1 || format.bits !== 16 || !Number.isSafeInteger(format.rate)
    || format.rate <= 0 || !data || data.length % 2) fail('mono_pcm16_required');
  return { data, rate: format.rate, samples: data.length / 2 };
}

/** Isolate only the exact invalid declared window. No range correction, padding,
 * material approval or inference. Native decode is rechecked against bound PCM. */
export async function loadInvalidMaterialWindows(binding, { ffmpeg = 'ffmpeg' } = {}) {
  await verifyEvidenceBindings(binding); const record = await readJson(binding.path);
  if (record.schema_version !== 1 || record.kind !== 'invalid_material_window_evidence'
    || record.source_windows_changed !== false || record.silence_padding_applied !== false
    || record.qualified !== false || record.production_approval !== false
    || !Array.isArray(record.windows) || !record.windows.length || record.windows.length > 8) fail('record_contract');
  await verifyEvidenceBindings([record.full_decode_report, record.prepared_samples_report, record.candidates]);
  const full = await readJson(record.full_decode_report.path), prepared = await readJson(record.prepared_samples_report.path);
  const candidates = await readJson(record.candidates.path), windows = [], identities = new Set();
  if (full.kind !== 'actual_full_native_decode_compared_to_original_declared_window'
    || full.no_silence_padding !== true || full.no_source_window_changed !== true
    || prepared.kind !== 'readonly_existing_prepared_sfx_clock_probe') fail('original_reports_required');
  for (const entry of record.windows) {
    if (!entry.source || !validRange(entry.source_range)) fail('exact_source_window_required');
    const identity = JSON.stringify([entry.source.sha256, entry.source_range]);
    if (identities.has(identity)) fail('duplicate_window'); identities.add(identity);
    await verifyEvidenceBindings([entry.source, entry.native_pcm_wav]);
    const match = row => row.source_file?.sha256 === entry.source.sha256 && equal(row.source_range, entry.source_range);
    const actualRows = full.rows.filter(match), preparedRows = prepared.rows.filter(match);
    if (actualRows.length !== 1 || preparedRows.length !== 1) fail('unique_original_report_row_required');
    const actual = actualRows[0], earlier = preparedRows[0];
    const original = candidates.tasks.flatMap(task => task.candidates).find(row => row.candidate.source_sha256 === entry.source.sha256
      && equal(row.candidate.source_range, entry.source_range) && row.candidate.segment_id === actual.segment_id);
    if (!original || original.source_file.path !== entry.source.path || actual.source_file.path !== entry.source.path
      || actual.source_file_unchanged !== true || actual.decode_exit !== 0 || actual.decoder_stderr !== '') fail('actual_source_or_decode_changed');
    await verifyEvidenceBindings({ path: earlier.input, sha256: earlier.input_sha256 });
    const native = pcm(await readFile(entry.native_pcm_wav.path)), prior = pcm(await readFile(earlier.input));
    if (native.rate !== actual.native_full_decode_rate || native.samples !== actual.native_full_decode_samples
      || native.rate !== Number(actual.declared?.streams?.[0]?.sample_rate)
      || shaBytes(native.data) !== actual.decoded_pcm_sha256
      || actual.decoded_duration_seconds !== native.samples / native.rate
      || prior.rate !== earlier.sample_rate || prior.samples !== earlier.actual_samples
      || earlier.expected_samples !== (entry.source_range[1] - entry.source_range[0]) * prior.rate
      || earlier.expected_samples - prior.samples <= 1 + prior.rate * 1e-8
      || entry.source_range[1] * native.rate <= native.samples + 1) fail('actual_window_not_beyond_decoded_tail');
    // Reproduce only these short full decodes; old ASR/PANN observations are not
    // touched. This rejects a newly hashed but fabricated PCM/receipt pair.
    const args = ['-hide_banner','-loglevel','error','-nostdin','-i',entry.source.path,'-vn','-ac','1','-ar',String(native.rate),
      '-c:a','pcm_s16le','-f','s16le','pipe:1'];
    if (!equal(actual.decode_command, ['ffmpeg', ...args])) fail('full_decode_command_changed');
    const decoded = await execute(ffmpeg, args, { windowsHide: true, encoding: 'buffer', timeout: 30000,
      maxBuffer: Math.max(1024 * 1024, native.data.length + 65536) });
    if (decoded.stderr.length || !decoded.stdout.equals(native.data)) fail('actual_decode_replay_changed');
    await verifyEvidenceBindings(entry.source);
    windows.push({ source_sha256: entry.source.sha256, source_range: [...entry.source_range],
      segment_id: actual.segment_id, evidence: binding, native_pcm_wav: entry.native_pcm_wav,
      decoded_duration_seconds: native.samples / native.rate, reason: 'declared_window_exceeds_actual_full_decoded_tail',
      source_window_changed: false, qualified: false, production_approval: false });
  }
  return { evidence: binding, windows, new_model_calls: 0, source_windows_changed: false, qualified: false, production_approval: false };
}
