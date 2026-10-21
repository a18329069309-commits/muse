import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, access, copyFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const finalMixMasterRevision = 'uniform-final-bus-master-v1';
export const finalMixMasterFile = 'final-mix-master.json';
const here = path.dirname(fileURLToPath(import.meta.url)), run = promisify(execFile), RATE = 48000;
const guardDb = 0.1, targetDb = -2, maximumAttempts = 2;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const digest = value => hash(canonical(value));
const fail = reason => { throw Error('final_mix_master_' + reason); };
const execute = (tool, args, options = {}) => run(tool, args, { windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...options });
const binding = async file => ({ path: path.resolve(file), sha256: hash(await readFile(file)) });
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const same = (a, b) => digest(a) === digest(b);
const inside = (file, directory) => path.dirname(path.resolve(file)) === path.resolve(directory);
async function verifyFile(ref) {
  if (!path.isAbsolute(ref?.path ?? '') || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')
    || hash(await readFile(ref.path)) !== ref.sha256) fail('file_binding_changed');
}

export function validateFinalMixMasterConfig(config) {
  if (!config || !same(config, { revision: finalMixMasterRevision, target_true_peak_dbtp: targetDb }))
    fail('explicit_supported_config_required');
  return { revision: finalMixMasterRevision, target_true_peak_dbtp: targetDb };
}
async function algorithms() {
  return Promise.all(['final_mix_master.mjs', 'render_audio.mjs', 'render_binding.mjs'].map(file => binding(path.join(here, file))));
}
async function decode(file) {
  const { stdout } = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-i', file, '-map', '0:a:0',
    '-ar', String(RATE), '-ac', '2', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' });
  if (!stdout.length || stdout.length % 8) fail('invalid_pcm');
  const data = new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length));
  if (data.some(value => !Number.isFinite(value))) fail('nonfinite_pcm');
  return data;
}
function peak(data) {
  let maximum = 0;
  for (const value of data) maximum = Math.max(maximum, Math.abs(value));
  return { linear: maximum, dbfs: maximum ? 20 * Math.log10(maximum) : null, silence: maximum === 0, clipped: maximum >= 1 };
}
function pcm24(data) {
  const bytes = Buffer.alloc(44 + data.length * 3);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 6, 28); bytes.writeUInt16LE(6, 32); bytes.writeUInt16LE(24, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(data.length * 3, 40);
  for (let i = 0; i < data.length; i++) {
    const integer = Math.round(data[i] * 8388608);
    if (integer < -8388608 || integer > 8388607) fail('integer_clamping_would_be_required');
    bytes.writeIntLE(integer, 44 + i * 3, 3);
  }
  return bytes;
}
function mastered(raw, gainDb) {
  if (!Number.isFinite(gainDb) || gainDb > 0) fail('nonpositive_constant_gain_required');
  const factor = 10 ** (gainDb / 20), data = Float32Array.from(raw, value => value * factor);
  return { data, factor, bytes: pcm24(data) };
}
function parseMeter(stderr) {
  const text = stderr.slice(stderr.lastIndexOf('Summary:'));
  const parse = expression => {
    const value = text.match(expression)?.[1];
    if (value === undefined) fail('true_peak_measurement_required');
    return Number.isFinite(Number(value)) ? Number(value) : null;
  };
  return { integrated_lufs: parse(/I:\s*([-+\d.]+|[-+]?inf)\s+LUFS/i),
    true_peak_dbtp: parse(/Peak:\s*([-+\d.]+|[-+]?inf)\s+dBFS/i), precision_db: 0.1 };
}
const meterArgsFor = (file, raw = false) => ['-hide_banner', '-nostats', '-nostdin', ...(raw ? ['-f', 'f32le', '-ar', String(RATE), '-ac', '2'] : []),
  '-i', file, '-map', '0:a:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'];
async function measure(file, { raw = false, logFile } = {}) {
  const args = meterArgsFor(file, raw);
  const { stderr } = await execute('ffmpeg', args);
  if (logFile) await writeFile(logFile, stderr, { flag: 'wx' });
  return { ...parseMeter(stderr), ...(logFile ? { receipt: await binding(logFile), command: 'ffmpeg', args } : {}) };
}
async function measureRawBytes(bytes) {
  const pending = execute('ffmpeg', ['-hide_banner', '-nostats', '-nostdin', '-f', 'f32le', '-ar', String(RATE), '-ac', '2',
    '-i', 'pipe:0', '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-']);
  pending.child.stdin.end(bytes);
  return parseMeter((await pending).stderr);
}
const encodeArgsFor = (pcm, encoded, N) => ['-v', 'error', '-nostdin', '-n', '-i', pcm, '-map', '0:a:0', '-c:a', 'aac',
  '-b:a', '192000', '-ar', String(RATE), '-t', String(N / RATE), encoded];
async function verifyEncodedOperands(pcm, encoded, N) {
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_streams', '-of', 'json', encoded]);
  const stream = JSON.parse(stdout).streams?.[0];
  if (stream?.codec_name !== 'aac' || stream.channels !== 2 || Number(stream.sample_rate) !== RATE
    || stream.time_base !== '1/48000' || Number(stream.start_pts) !== 0 || Number(stream.duration_ts) !== N)
    fail('encoded_clock_or_format_changed');
  const current = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-i', pcm, '-map', '0:a:0', '-c:a', 'aac',
    '-b:a', '192000', '-ar', String(RATE), '-t', String(N / RATE), '-f', 'adts', 'pipe:1'], { encoding: 'buffer' });
  const actual = await execute('ffmpeg', ['-v', 'error', '-nostdin', '-i', encoded, '-map', '0:a:0',
    '-c:a', 'copy', '-f', 'adts', 'pipe:1'], { encoding: 'buffer' });
  if (!current.stdout.equals(actual.stdout)) fail('encoded_audio_operands_changed');
}
const safe = (measurement, silence) => measurement.true_peak_dbtp === null ? silence
  : measurement.true_peak_dbtp + 0.05 <= targetDb;
const initialGain = rawPeak => rawPeak === null ? 0 : -Math.ceil(Math.max(0, rawPeak - targetDb + guardDb) * 10) / 10;
const nextGain = (gain, encodedPeak) => gain - Math.ceil((encodedPeak - targetDb + guardDb) * 10) / 10;

async function context(planFile, renderDirectory, report) {
  const { verifyRenderBinding } = await import('./render_binding.mjs');
  const issues = await verifyRenderBinding(planFile, renderDirectory, report, { checkFinalMix: false });
  if (issues.length) fail('raw_render_binding_changed:' + issues.join(','));
  const reportFile = path.join(renderDirectory, 'report.json'), onDisk = await readJson(reportFile);
  if (!same(onDisk, report)) fail('actual_raw_report_required');
  const peaks = report.output_sample_peaks_before_pcm_clamping;
  if (!peaks || ['bgm', 'sfx', 'ambience', 'accompaniment'].some(track => peaks[track]?.clipped !== false))
    fail('clipped_raw_stem_cannot_be_repaired');
  const plan = await readJson(planFile), manifest = await readJson(path.resolve(path.dirname(planFile), plan.manifest));
  const originalFile = path.resolve(path.dirname(path.resolve(path.dirname(planFile), plan.manifest)), manifest.original_audio);
  const N = report.duration_samples, original = await decode(originalFile), accompaniment = await decode(path.join(renderDirectory, 'accompaniment.wav'));
  if (!Number.isSafeInteger(N) || N <= 0 || original.length !== 2 * N || accompaniment.length !== 2 * N)
    fail('full_timeline_clock_changed');
  if (peak(accompaniment).clipped) fail('actual_accompaniment_clipped');
  const raw = Float32Array.from(original, (value, i) => value + accompaniment[i]);
  return { N, raw, rawBytes: Buffer.from(raw.buffer), input: { source_sha256: report.source_sha256,
    raw_report: await binding(reportFile), plan: await binding(planFile), manifest: await binding(path.resolve(path.dirname(planFile), plan.manifest)),
    original_audio: await binding(originalFile), assets: report.input_binding.asset_sha256,
    stems: await Promise.all(['bgm', 'sfx', 'ambience', 'accompaniment'].map(track => binding(path.join(renderDirectory, track + '.wav')))) } };
}

// A distinct technical master; the raw report, four stems and source files remain immutable.
export async function createFinalMixMaster({ planFile, renderDirectory, report, config, outputDirectory = renderDirectory }) {
  config = validateFinalMixMasterConfig(config);
  const ctx = await context(path.resolve(planFile), path.resolve(renderDirectory), report), out = path.resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const recordFile = path.join(out, finalMixMasterFile), output = path.join(out, 'final_mix.wav');
  for (const file of [recordFile, output]) {
    try { await access(file); fail('output_already_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const temporary = path.join(out, '.final-mix-unmastered.f32le');
  await writeFile(temporary, ctx.rawBytes, { flag: 'wx' });
  let rawMeasurement;
  try { rawMeasurement = await measure(temporary, { raw: true, logFile: path.join(out, 'final-mix-raw-ebur128.log') }); }
  finally { await rm(temporary, { force: true }); }
  const toolVersion = (await execute('ffmpeg', ['-version'])).stdout.split(/\r?\n/)[0];
  const attempts = []; let gainDb = initialGain(rawMeasurement.true_peak_dbtp), accepted;
  for (let index = 1; index <= maximumAttempts; index++) {
    const pcm = path.join(out, `final-mix-attempt-${index}.wav`), encoded = path.join(out, `final-mix-attempt-${index}.m4a`);
    const current = mastered(ctx.raw, gainDb);
    await writeFile(pcm, current.bytes, { flag: 'wx' });
    const encodeArgs = encodeArgsFor(pcm, encoded, ctx.N);
    await execute('ffmpeg', encodeArgs);
    const pcmMeasurement = await measure(pcm, { logFile: path.join(out, `final-mix-pcm-${index}-ebur128.log`) });
    const encodedMeasurement = await measure(encoded, { logFile: path.join(out, `final-mix-aac-${index}-ebur128.log`) });
    attempts.push({ attempt: index, gain_db: gainDb, pcm: await binding(pcm), encoded: await binding(encoded),
      encode_command: 'ffmpeg', encode_args: encodeArgs, pcm_measurement: pcmMeasurement, encoded_measurement: encodedMeasurement });
    if (safe(pcmMeasurement, peak(current.data).silence) && safe(encodedMeasurement, peak(current.data).silence)) {
      accepted = current; await copyFile(pcm, output, 1); break;
    }
    if (index === maximumAttempts || encodedMeasurement.true_peak_dbtp === null) fail('actual_pcm_or_encoded_true_peak_exceeds_target');
    gainDb = nextGain(gainDb, Math.max(pcmMeasurement.true_peak_dbtp ?? -Infinity, encodedMeasurement.true_peak_dbtp));
  }
  const master = { schema_version: 1, kind: 'independent_technical_final_bus_master', config,
    composition: 'original once + delivered accompaniment once', inputs: ctx.input,
    provenance: { algorithms: await algorithms(), config_sha256: digest(config), ffmpeg_version: toolVersion,
      unmastered_float32_pcm_sha256: hash(ctx.rawBytes), measurement_guard_db: guardDb },
    mastering: { operation: 'uniform_gain_after_original_plus_accompaniment', gain_db: gainDb, factor: accepted.factor,
      relative_dialogue_music_balance_changed: false, authored_gain_envelopes_changed: false, compression_or_limiting_applied: false },
    duration_samples: ctx.N, sample_rate: RATE, channels: 2, bit_depth: 24, final_mix: await binding(output),
    raw_mix_measurement: rawMeasurement, sample_peak_before_pcm_clamping: peak(accepted.data), attempts,
    status: 'technical_safe_final_bus', raw_mix_status: report.status, raw_mix_issues: report.issues,
    raw_mix_approved: false, raw_outputs_modified: false, source_facts_approved: false, production_approval: false,
    creative_review: 'not_performed', audible_sync_review: 'not_performed', account_calls: 0 };
  await writeFile(recordFile, JSON.stringify(master, null, 2) + '\n', { flag: 'wx' });
  return { report: await binding(recordFile), final_mix: master.final_mix, master };
}

export async function verifyFinalMixMaster({ planFile, renderDirectory, report, expectedConfig,
  masterReportFile = path.join(renderDirectory, finalMixMasterFile) }) {
  try {
    const master = await readJson(masterReportFile), config = validateFinalMixMasterConfig(master.config);
    if (expectedConfig !== undefined && !same(validateFinalMixMasterConfig(expectedConfig), config)) fail('config_changed');
    const out = path.dirname(path.resolve(masterReportFile)), ctx = await context(path.resolve(planFile), path.resolve(renderDirectory), report);
    if (master.schema_version !== 1 || master.kind !== 'independent_technical_final_bus_master'
      || master.composition !== 'original once + delivered accompaniment once' || !same(master.inputs, ctx.input)
      || !same(master.provenance.algorithms, await algorithms()) || master.provenance.config_sha256 !== digest(config)
      || master.provenance.unmastered_float32_pcm_sha256 !== hash(ctx.rawBytes) || master.provenance.measurement_guard_db !== guardDb
      || master.provenance.ffmpeg_version !== (await execute('ffmpeg', ['-version'])).stdout.split(/\r?\n/)[0]
      || master.duration_samples !== ctx.N || master.sample_rate !== RATE || master.channels !== 2 || master.bit_depth !== 24
      || master.status !== 'technical_safe_final_bus' || master.raw_mix_status !== report.status || !same(master.raw_mix_issues, report.issues)
      || master.raw_mix_approved !== false || master.raw_outputs_modified !== false || master.source_facts_approved !== false
      || master.production_approval !== false || master.creative_review !== 'not_performed' || master.audible_sync_review !== 'not_performed'
      || master.account_calls !== 0 || !Array.isArray(master.attempts) || !master.attempts.length || master.attempts.length > maximumAttempts)
      fail('provenance_or_qualification_changed');
    await verifyFile(master.raw_mix_measurement.receipt);
    if (master.raw_mix_measurement.command !== 'ffmpeg'
      || master.raw_mix_measurement.receipt.path !== path.join(out, 'final-mix-raw-ebur128.log')
      || !same(master.raw_mix_measurement.args, meterArgsFor(path.join(out, '.final-mix-unmastered.f32le'), true)))
      fail('raw_measurement_provenance_changed');
    const rawMeasured = parseMeter(await readFile(master.raw_mix_measurement.receipt.path, 'utf8'));
    if (!same(rawMeasured, { integrated_lufs: master.raw_mix_measurement.integrated_lufs,
      true_peak_dbtp: master.raw_mix_measurement.true_peak_dbtp, precision_db: master.raw_mix_measurement.precision_db })) fail('raw_meter_changed');
    if (!same(rawMeasured, await measureRawBytes(ctx.rawBytes))) fail('actual_raw_meter_changed');
    let gainDb = initialGain(rawMeasured.true_peak_dbtp);
    for (const [i, attempt] of master.attempts.entries()) {
      if (attempt.attempt !== i + 1 || attempt.gain_db !== gainDb || !inside(attempt.pcm.path, out) || !inside(attempt.encoded.path, out)) fail('attempt_changed');
      if (attempt.pcm.path !== path.join(out, `final-mix-attempt-${i + 1}.wav`)
        || attempt.encoded.path !== path.join(out, `final-mix-attempt-${i + 1}.m4a`)
        || attempt.encode_command !== 'ffmpeg' || !same(attempt.encode_args, encodeArgsFor(attempt.pcm.path, attempt.encoded.path, ctx.N)))
        fail('encoding_provenance_changed');
      await verifyFile(attempt.pcm); await verifyFile(attempt.encoded);
      await verifyEncodedOperands(attempt.pcm.path, attempt.encoded.path, ctx.N);
      const current = mastered(ctx.raw, gainDb);
      if (hash(current.bytes) !== attempt.pcm.sha256) fail('constant_gain_operands_changed');
      for (const [measurement, file, kind] of [[attempt.pcm_measurement, attempt.pcm.path, 'pcm'], [attempt.encoded_measurement, attempt.encoded.path, 'aac']]) {
        if (measurement.command !== 'ffmpeg' || measurement.receipt.path !== path.join(out, `final-mix-${kind}-${i + 1}-ebur128.log`)
          || !same(measurement.args, meterArgsFor(file))) fail('actual_measurement_provenance_changed');
        await verifyFile(measurement.receipt);
        const actual = await measure(file), saved = parseMeter(await readFile(measurement.receipt.path, 'utf8'));
        if (!same(actual, saved) || !same(actual, { integrated_lufs: measurement.integrated_lufs,
          true_peak_dbtp: measurement.true_peak_dbtp, precision_db: measurement.precision_db })) fail('actual_meter_changed');
      }
      const isSafe = safe(attempt.pcm_measurement, peak(current.data).silence) && safe(attempt.encoded_measurement, peak(current.data).silence);
      if (i < master.attempts.length - 1 && isSafe || i === master.attempts.length - 1 && !isSafe) fail('actual_peak_target_not_satisfied');
      if (i < master.attempts.length - 1) gainDb = nextGain(gainDb, Math.max(attempt.pcm_measurement.true_peak_dbtp ?? -Infinity, attempt.encoded_measurement.true_peak_dbtp));
    }
    const last = master.attempts.at(-1), expected = mastered(ctx.raw, last.gain_db);
    if (!same(master.mastering, { operation: 'uniform_gain_after_original_plus_accompaniment', gain_db: last.gain_db,
      factor: expected.factor, relative_dialogue_music_balance_changed: false, authored_gain_envelopes_changed: false, compression_or_limiting_applied: false })
      || master.final_mix.path !== path.join(out, 'final_mix.wav') || master.final_mix.sha256 !== last.pcm.sha256
      || !same(master.sample_peak_before_pcm_clamping, peak(expected.data))) fail('final_gain_or_output_changed');
    await verifyFile(master.final_mix);
    return { issues: [], master, report: await binding(masterReportFile) };
  } catch (error) { return { issues: [error.message], master: null }; }
}
