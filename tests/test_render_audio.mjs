import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { renderPlan } from '../scripts/render_audio.mjs';

const RATE = 48000, LENGTH = RATE * 2;
async function command(name, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(name, args, { windowsHide: true, shell: false }), chunks = [];
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.resume(); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${name}: ${code}`)));
  });
}

// Independent 16-bit fixture writer; production output is decoded with FFmpeg.
async function audio(file, frames, valueAt) {
  const raw = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.round(valueAt(i) * 32768);
    raw.writeInt16LE(value, i * 4); raw.writeInt16LE(value, i * 4 + 2);
  }
  const rawFile = `${file}.s16le`;
  await writeFile(rawFile, raw);
  await command('ffmpeg', ['-v', 'error', '-f', 's16le', '-ar', '48000', '-ac', '2',
    '-i', rawFile, '-c:a', 'pcm_s16le', file]);
  await rm(rawFile);
}

async function decoded(file) {
  const raw = await command('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', 'pipe:1']);
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
}

async function fixture(t, originalAt) {
  const root = await mkdtemp(path.join(tmpdir(), 'short-drama-render-'));
  t.after(() => {
    const target = path.resolve(root), temporaryRoot = path.resolve(tmpdir());
    assert.equal(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('short-drama-render-'));
    return rm(target, { recursive: true, force: true });
  });
  const source = path.join(root, 'source.mp4');
  await command('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=64x64:r=25:d=2',
    '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source]);
  await audio(path.join(root, 'original.wav'), LENGTH, originalAt ?? (() => 0));
  const hash = createHash('sha256').update(await readFile(source)).digest('hex');
  await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ schema_version: 1,
    source_video: source, source_sha256: hash, timeline: { sample_rate: RATE, duration_samples: LENGTH },
    has_source_audio: originalAt !== undefined, original_audio: 'original.wav' }));
  const plan = { schema_version: 1, manifest: 'manifest.json', audience: 'male', mode: 'materials',
    execution: 'local', original_audio_kind: originalAt ? 'dialogue_only' : 'none',
    dialogue_intervals: [], assets: [], cues: [] };
  const asset = async (id, frames, valueAt) => {
    await audio(path.join(root, `${id}.wav`), frames, valueAt);
    plan.assets.push({ id, path: `${id}.wav` });
  };
  const render = async (output = 'out') => {
    await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan));
    // A synthetic isolated unit fixture has no project-trial authorization or user video.
    // Keep its execution scope in the temporary fixture instead of the shell's project cwd.
    return renderPlan(path.join(root, 'plan.json'), path.join(root, output), { cwd: root });
  };
  return { root, plan, asset, render, source };
}

const cue = (id, track, assetId, sourceOut, placement) => ({ id, track, asset_id: assetId,
  source_in_seconds: 0, source_out_seconds: sourceOut, gain_db: 0,
  fade_in_seconds: 0, fade_out_seconds: 0, ...placement });

test('Nonzero prepared original cannot bypass review by declaring no audio', async t => {
  const f = await fixture(t, () => 0.05);
  f.plan.original_audio_kind = 'none';
  const report = await f.render();
  assert.equal(report.status, 'needs_mix_review');
  assert.ok(report.issues.includes('declared_no_audio_but_original_has_signal'));
});

test('auto audience remains explicit through renderer without forcing a gender style', async t => {
  const f = await fixture(t); f.plan.audience = 'auto';
  const report = await f.render(); assert.equal(report.status, 'technical_ok');
  const saved = JSON.parse(await readFile(path.join(f.root, 'plan.json'), 'utf8'));
  assert.equal(saved.audience, 'auto');
});

test('Measured asset anchor aligns the actual WAV pulse to target sample', async t => {
  const f = await fixture(t);
  await f.asset('pulse', 19200, i => i === 9600 ? 0.25 : 0);
  f.plan.cues.push(cue('pulse01', 'sfx', 'pulse', 0.4,
    { sync: { target_seconds: 0.8, source_anchor_seconds: 0.2 } }));
  const report = await f.render(), output = await decoded(path.join(f.root, 'out', 'sfx.wav'));
  assert.equal(output.length, LENGTH * 2);
  assert.equal(output.findIndex(value => Math.abs(value) > 0.01), 38400 * 2);
  assert.equal(report.cues[0].start_sample, 28800);
  assert.equal(report.status, 'technical_ok');
  assert.equal(report.creative_review, 'not_performed');
  const probe = JSON.parse((await command('ffprobe', ['-v', 'error', '-show_entries',
    'stream=sample_rate,channels,bits_per_sample,duration_ts', '-of', 'json', path.join(f.root, 'out', 'sfx.wav')])).toString());
  assert.equal(probe.streams[0].sample_rate, '48000');
  assert.equal(probe.streams[0].channels, 2);
  assert.equal(probe.streams[0].bits_per_sample, 24);
  assert.equal(probe.streams[0].duration_ts, LENGTH);
});

test('Negative start trims leading samples and preserves the event anchor', async t => {
  const f = await fixture(t);
  await f.asset('pulse', 19200, i => i === 9600 ? 0.25 : 0);
  f.plan.cues.push(cue('pulse01', 'sfx', 'pulse', 0.4,
    { sync: { target_seconds: 0.1, source_anchor_seconds: 0.2 } }));
  const report = await f.render(), output = await decoded(path.join(f.root, 'out', 'sfx.wav'));
  assert.equal(output.findIndex(value => Math.abs(value) > 0.01), 4800 * 2);
  assert.equal(report.cues[0].leading_trim_samples, 4800);
});

test('Accompaniment excludes dialogue; complete mix contains original once', async t => {
  const f = await fixture(t, i => i === 48000 ? 0.25 : 0);
  await f.asset('pulse', 19200, i => i === 9600 ? 0.125 : 0);
  f.plan.cues.push(cue('pulse01', 'sfx', 'pulse', 0.4,
    { sync: { target_seconds: 1, source_anchor_seconds: 0.2 } }));
  const report = await f.render(), output = await decoded(path.join(f.root, 'out', 'accompaniment.wav'));
  assert.equal(output[48000 * 2], 0.125);
  assert.equal(report.complete_mix.sample_peak_before_pcm_clamping.linear, 0.375);
  assert.equal(report.complete_mix.composition, 'original once + accompaniment once');
  assert.equal(typeof report.complete_mix.true_peak_dbfs, 'number');
});

test('Overlapping dialogue applies one minimum ducking envelope', async t => {
  const f = await fixture(t);
  await f.asset('bed', 72000, () => 0.25);
  f.plan.cues.push(cue('bed01', 'bgm', 'bed', 1.5, { start_seconds: 0 }));
  f.plan.dialogue_intervals = [{ start_seconds: 0.4, end_seconds: 0.9 },
    { start_seconds: 0.6, end_seconds: 1.2 }];
  await f.render();
  const output = await decoded(path.join(f.root, 'out', 'bgm.wav'));
  assert.ok(Math.abs(output[33600 * 2] - 0.25 * 10 ** (-10 / 20)) < 0.000001);
  assert.equal(output[12000 * 2], 0.25);
  assert.equal(output[69600 * 2], 0.25);
  assert.ok(output[18000 * 2] < 0.25 && output[18000 * 2] > 0.25 * 10 ** (-10 / 20));
});

test('Configurable speech ducking preserves the measured 3.5 dB level and rejects invalid reductions', async t => {
  const f = await fixture(t);
  await f.asset('bed', 72000, () => 0.25);
  f.plan.cues.push(cue('bed01', 'bgm', 'bed', 1.5, { start_seconds: 0 }));
  f.plan.dialogue_intervals = [{ start_seconds: 0.4, end_seconds: 0.9 }];
  const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  const speechRms = async output => rms((await decoded(path.join(f.root, output, 'bgm.wav')))
    .subarray(24000 * 2, 38400 * 2));
  const defaultReport = await f.render('default-ducking');
  const defaultRms = await speechRms('default-ducking');
  assert.ok(Math.abs(defaultRms - 0.25 * 10 ** (-10 / 20)) < 0.000001);
  assert.equal(defaultReport.dialogue_ducking.reduction_db, 10);
  f.plan.dialogue_ducking_db = 3.5;
  const lightReport = await f.render('light-ducking');
  const lightRms = await speechRms('light-ducking');
  assert.ok(Math.abs(lightRms - 0.25 * 10 ** (-3.5 / 20)) < 0.000001);
  assert.ok(Math.abs(20 * Math.log10(lightRms / defaultRms) - 6.5) < 0.0001);
  assert.equal(lightReport.dialogue_ducking.reduction_db, 3.5);
  for (const value of [-0.1, 18.1, null, '3.5']) {
    f.plan.dialogue_ducking_db = value;
    await assert.rejects(f.render('invalid-ducking'), /dialogue_ducking_db/);
  }
});

test('Tail outside the timeline is rejected without implicit hard trim', async t => {
  const f = await fixture(t);
  await f.asset('pulse', 19200, () => 0.25);
  f.plan.cues.push(cue('pulse01', 'sfx', 'pulse', 0.4, { start_seconds: 1.8 }));
  await assert.rejects(f.render(), /tail exceeds timeline/);
});

test('Authored gain automation and raised-cosine fades survive real PCM rendering', async t => {
  const f = await fixture(t);
  await f.asset('tone', RATE, () => 0.25);
  f.plan.cues.push(cue('automated', 'bgm', 'tone', 1, { start_seconds: 0.2,
    fade_in_seconds: 0.2, fade_out_seconds: 0.2, fade_curve: 'raised_cosine',
    gain_envelope: [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 0.4, gain_db: 0 },
      { offset_seconds: 0.6, gain_db: -6 }, { offset_seconds: 1, gain_db: -6 }] }));
  const report = await f.render();
  const output = await decoded(path.join(f.root, 'out', 'bgm.wav'));
  const at = seconds => output[Math.round(seconds * RATE) * 2];
  assert.ok(Math.abs(at(0.3) - 0.125) < 1e-6, 'fade midpoint is half the source amplitude');
  assert.ok(Math.abs(at(0.5) - 0.25) < 1e-6, 'first authored plateau remains intact');
  assert.ok(Math.abs(at(0.9) - 0.25 * 10 ** (-6 / 20)) < 1e-6, 'later authored reduction is measured in PCM');
  assert.equal(at(0.2), 0);
  assert.equal(report.cues[0].fade_curve, 'raised_cosine');
  assert.equal(report.cues[0].gain_envelope.at(-1).offset_sample, RATE);
  f.plan.cues[0].gain_envelope[1].offset_seconds = 0;
  await assert.rejects(f.render('bad-envelope'), /increasing sample offsets/);
  f.plan.cues[0].gain_envelope = [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 0.9, gain_db: 0 }];
  await assert.rejects(f.render('short-envelope'), /span the source segment/);
  delete f.plan.cues[0].gain_envelope;
  f.plan.cues[0].fade_curve = 'unknown';
  await assert.rejects(f.render('bad-curve'), /fade_curve/);
});

test('Omitted fade curve preserves explicit linear PCM and raised-cosine endpoints', async t => {
  const f = await fixture(t);
  await f.asset('bed', RATE, () => 0.25);
  f.plan.cues.push(cue('bed01', 'bgm', 'bed', 1,
    { start_seconds: 0.25, fade_in_seconds: 0.25, fade_out_seconds: 0.25 }));
  const defaultReport = await f.render('default-curve');
  const defaultWav = await readFile(path.join(f.root, 'default-curve', 'bgm.wav'));
  f.plan.cues[0].fade_curve = 'linear';
  const linearReport = await f.render('linear-curve');
  assert.deepEqual(await readFile(path.join(f.root, 'linear-curve', 'bgm.wav')), defaultWav);
  assert.equal(defaultReport.cues[0].fade_curve, 'linear');
  assert.equal(defaultReport.output_sha256.bgm, linearReport.output_sha256.bgm);
  const linear = await decoded(path.join(f.root, 'linear-curve', 'bgm.wav'));
  assert.equal(linear[Math.round(0.3125 * RATE) * 2], 0.0625);
  f.plan.cues[0].fade_curve = 'raised_cosine';
  const raisedReport = await f.render('raised-curve');
  const raised = await decoded(path.join(f.root, 'raised-curve', 'bgm.wav'));
  assert.ok(Math.abs(raised[Math.round(0.3125 * RATE) * 2] - 0.03661165) < 1e-6);
  for (const data of [linear, raised]) {
    assert.equal(data[Math.round(0.25 * RATE) * 2], 0);
    assert.equal(data[Math.round(1.25 * RATE) * 2 - 2], 0);
    assert.equal(data[Math.round(0.75 * RATE) * 2], 0.25);
  }
  assert.equal(raisedReport.cues[0].fade_curve, 'raised_cosine');
});

test('Optional equal-power fade reduces the midpoint energy dip for uncorrelated WAV sources', async t => {
  const f = await fixture(t);
  await f.asset('low', RATE * 1.5, i => 0.25 * Math.sin(2 * Math.PI * 400 * i / RATE));
  await f.asset('high', RATE * 1.5, i => 0.25 * Math.sin(2 * Math.PI * 600 * i / RATE));
  f.plan.cues.push(cue('outgoing', 'bgm', 'low', 1.5,
    { start_seconds: 0, fade_out_seconds: 1, fade_curve: 'raised_cosine' }),
    cue('incoming', 'bgm', 'high', 1.5,
      { start_seconds: 0.5, fade_in_seconds: 1, fade_curve: 'raised_cosine' }));
  const first = Math.round(0.98 * RATE), last = Math.round(1.02 * RATE);
  const rms = data => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
  const low = (await decoded(path.join(f.root, 'low.wav'))).subarray(first * 2, last * 2);
  const high = (await decoded(path.join(f.root, 'high.wav')))
    .subarray((first - RATE / 2) * 2, (last - RATE / 2) * 2);
  const product = low.reduce((sum, value, i) => sum + value * high[i], 0) / low.length;
  assert.ok(Math.abs(product / (rms(low) * rms(high))) < 1e-5, 'fixture sources are uncorrelated in the measured window');
  const raisedReport = await f.render('raised-overlap');
  const raised = (await decoded(path.join(f.root, 'raised-overlap', 'bgm.wav'))).subarray(first * 2, last * 2);
  f.plan.cues.forEach(c => { c.fade_curve = 'equal_power'; });
  const equalReport = await f.render('equal-overlap');
  const equal = (await decoded(path.join(f.root, 'equal-overlap', 'bgm.wav'))).subarray(first * 2, last * 2);
  assert.ok(Math.abs(20 * Math.log10(rms(equal) / rms(low))) < 0.05, 'midpoint RMS stays near one source RMS');
  assert.ok(20 * Math.log10(rms(equal) / rms(raised)) > 2.9, 'equal-power improves the midpoint dip by about 3 dB');
  assert.equal(equalReport.status, 'technical_ok');
  assert.equal(equalReport.creative_review, 'not_performed');
  assert.ok(equalReport.cues.every(c => c.fade_curve === 'equal_power'));
  assert.notEqual(equalReport.input_binding.plan_sha256, raisedReport.input_binding.plan_sha256);
  assert.equal(equalReport.output_sha256.bgm,
    createHash('sha256').update(await readFile(path.join(f.root, 'equal-overlap', 'bgm.wav'))).digest('hex'));
});

test('Equal-power same-phase WAV overlap raises peaks and preserves overload review', async t => {
  const f = await fixture(t);
  await f.asset('tone', RATE * 1.5, i => 0.8 * Math.sin(2 * Math.PI * 400 * i / RATE));
  f.plan.cues.push(cue('outgoing', 'bgm', 'tone', 1.5,
    { start_seconds: 0, fade_out_seconds: 1, fade_curve: 'linear' }),
    cue('incoming', 'bgm', 'tone', 1.5,
      { start_seconds: 0.5, fade_in_seconds: 1, fade_curve: 'linear' }));
  const linear = await f.render('linear-same-phase');
  assert.equal(linear.status, 'technical_ok');
  assert.ok(linear.output_sample_peaks_before_pcm_clamping.bgm.linear < 0.81);
  f.plan.cues.forEach(c => { c.fade_curve = 'equal_power'; });
  const report = await f.render('equal-same-phase');
  const peak = report.output_sample_peaks_before_pcm_clamping.bgm;
  assert.ok(peak.linear > 1.12 && peak.linear < 1.14, 'same-phase sum is not automatically normalized');
  assert.equal(peak.clipped, true);
  assert.equal(report.status, 'needs_mix_review');
  assert.ok(report.issues.includes('bgm_digital_overload'));
  assert.ok(report.issues.includes('accompaniment_digital_overload'));
  assert.ok(report.issues.includes('original_plus_accompaniment_digital_overload'));
  assert.equal(report.creative_review, 'not_performed');
  assert.ok(report.cues.every(c => c.gain_db === 0 && c.fade_curve === 'equal_power'));
  const output = await decoded(path.join(f.root, 'equal-same-phase', 'bgm.wav'));
  assert.ok(output.some(value => Math.abs(value) > 0.999), 'existing PCM clamping does not conceal the pre-clamp overload report');
});

test('Summed stems can overload even when each individual stem is below full scale', async t => {
  const f = await fixture(t);
  await f.asset('bed', 48000, () => 0.625);
  f.plan.cues.push(cue('bed01', 'bgm', 'bed', 1, { start_seconds: 0 }),
    cue('bed02', 'sfx', 'bed', 1, { start_seconds: 0 }));
  const report = await f.render();
  assert.equal(report.output_sample_peaks_before_pcm_clamping.bgm.clipped, false);
  assert.equal(report.output_sample_peaks_before_pcm_clamping.sfx.clipped, false);
  assert.equal(report.output_sample_peaks_before_pcm_clamping.accompaniment.linear, 1.25);
  assert.equal(report.status, 'needs_mix_review');
  assert.ok(report.issues.includes('original_plus_accompaniment_digital_overload'));
  assert.ok(report.complete_mix.true_peak_dbfs > 0);
});

test('Source-video identity is checked before rendering', async t => {
  const f = await fixture(t);
  await writeFile(f.source, Buffer.from('changed source'));
  await assert.rejects(f.render(), /SHA-256 mismatch/);
});

test('Missing dialogue intervals remain unknown and require review', async t => {
  const f = await fixture(t, i => i === 48000 ? 0.25 : 0);
  delete f.plan.dialogue_intervals;
  const report = await f.render();
  assert.equal(report.dialogue_ducking.status, 'not_provided');
  assert.equal(report.status, 'needs_mix_review');
});

test('An empty interval list does not prove dialogue is absent when source audio exists', async t => {
  const f = await fixture(t, i => i === 48000 ? 0.25 : 0);
  await f.asset('bed', 48000, () => 0.125);
  f.plan.cues.push(cue('bed01', 'bgm', 'bed', 1, { start_seconds: 0 }));
  const report = await f.render();
  assert.deepEqual(f.plan.dialogue_intervals, []);
  assert.equal(report.dialogue_ducking.status, 'not_provided');
  assert.ok(report.issues.includes('dialogue_intervals_not_provided'));
  assert.equal(report.status, 'needs_mix_review');
});

test('Invalid plans, analysis windows, and nonempty output are rejected', async t => {
  const f = await fixture(t);
  await f.asset('pulse', 19200, () => 0.25);
  const valid = cue('pulse01', 'sfx', 'pulse', 0.4, { start_seconds: 0 });
  const cases = [
    [[valid, valid], /duplicate cue id/],
    [[{ ...valid, track: 'voice' }], /Invalid cue track/],
    [[{ ...valid, gain_db: null }], /must be finite/],
    [[{ ...valid, source_out_seconds: 0.5 }], /real decoded asset/],
    [[{ ...valid, sync: { target_seconds: 0.5, source_anchor_seconds: 0.2 } }], /exactly one/],
    [[cue('sync01', 'sfx', 'pulse', 0.4,
      { sync: { target_seconds: 2, source_anchor_seconds: 0.2 } })], /outside the timeline/]
  ];
  for (const [cues, expected] of cases) {
    f.plan.cues = cues;
    await assert.rejects(f.render(), expected);
  }
  f.plan.cues = [valid];
  await f.render();
  await assert.rejects(f.render(), /must be empty/);
  f.plan.assets[0].path = 'missing.wav';
  await assert.rejects(f.render('missing-asset'), { code: 'ENOENT' });
  f.plan.assets[0].path = 'pulse.wav';
  const manifestPath = path.join(f.root, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath));
  manifest.analysis_window = { start_seconds: 0.5, end_seconds: 1, step_seconds: 0.04 };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(f.render('window'), /analysis window/);
});
