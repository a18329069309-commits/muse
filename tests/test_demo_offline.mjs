import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, cleanDemoEnvironment, demoErrorCode, runBounded, validatePreviewEvidence }
  from '../tools/demo-engine.mjs';
import { HELP, parseDemoArgs, runOfflineDemo, runEpisodeWorker } from '../tools/demo-offline.mjs';

const state = path.join(PROJECT_ROOT, '.muse');
await mkdir(state, { recursive: true });
// Test fixtures intentionally remain below the project for inspection, never in C:/Temp.
const root = await mkdtemp(path.join(state, 'demo-tests-'));
const location = name => path.join(root, name);
const cli = args => runBounded(process.execPath, [path.join(PROJECT_ROOT, 'tools/demo-offline.mjs'), ...args],
  { cwd: PROJECT_ROOT, env: cleanDemoEnvironment(root), timeout: 60000, limit: 1024 * 1024 });

test('demo help and invalid arguments have no output-directory side effects', async () => {
  const before = await readdir(state);
  assert.match((await cli(['--help'])).stdout.toString(), /NOT an operating-system network sandbox/);
  assert.deepEqual(await readdir(state), before);
  assert.match(HELP, /not automatic story analysis/i);
  for (const args of [['--episodes', '0'], ['--episodes', '01'], ['--episodes', '2.0'],
    ['--episodes'], ['--out'], ['--out', '--help'], ['--unknown'], ['--episodes', '1', '--episodes', '2']]) {
    assert.throws(() => parseDemoArgs(args), /demo_/);
  }
  for (const episodes of [0, 3, '1', null, NaN]) {
    await assert.rejects(runOfflineDemo({ out: location('invalid-number'), episodes }), /demo_episodes/);
  }
  await assert.rejects(cli(['--out', location('invalid-cli'), '--episodes', '3']), /demo_child_failed_exit_1/);
  assert.equal((await readdir(root)).includes('invalid-cli'), false);
});

test('new output guard preserves existing directories and refuses roots, empty values and C drive', async () => {
  const existing = location('existing'); await mkdir(existing);
  await writeFile(path.join(existing, 'sentinel.txt'), 'leave unchanged');
  await assert.rejects(runOfflineDemo({ out: existing, episodes: 1 }), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(existing, 'sentinel.txt'), 'utf8'), 'leave unchanged');
  const empty = location('empty'); await mkdir(empty);
  await assert.rejects(runOfflineDemo({ out: empty }), { code: 'EEXIST' });
  for (const out of ['', '   ', 'C:\\do-not-create', 'c:/do-not-create', PROJECT_ROOT, path.parse(PROJECT_ROOT).root]) {
    await assert.rejects(runOfflineDemo({ out, episodes: 1 }));
  }
  await assert.rejects(runOfflineDemo({ out: path.join(root, 'missing-parent', 'leaf'), episodes: 1 }),
    { code: 'ENOENT' });
  if (process.platform === 'win32') {
    // A D: junction targeting C: must not evade the realpath check.
    const junction = location('c-junction');
    await symlink('C:\\', junction, 'junction');
    await assert.rejects(runOfflineDemo({ out: path.join(junction, 'w-score-must-not-write'), episodes: 1 }),
      /demo_output_root_forbidden/);
  }
});

test('child environment strips provider credentials and refuses oversized/slow child processes', async () => {
  assert.equal(demoErrorCode(new Error('ASCII_SECRET_SHOULD_NOT_LEAK')), 'demo_episode_failed');
  assert.equal(demoErrorCode({ code: 'ASCII_SECRET_SHOULD_NOT_LEAK' }), 'demo_episode_failed');
  const inherited = { PATH: 'retained', ffreport: 'unsafe', RePoRt: 'unsafe', node_options: 'unsafe',
    av_log_force_color: '1', sdr_private: 'unsafe', OPENAI_API_KEY: 'unsafe' };
  const cleaned = cleanDemoEnvironment(root, inherited);
  assert.equal(cleaned.PATH, 'retained');
  for (const key of ['ffreport', 'RePoRt', 'node_options', 'av_log_force_color', 'sdr_private', 'OPENAI_API_KEY'])
    assert.equal(cleaned[key], undefined);
  assert.equal(inherited.ffreport, 'unsafe');
  const previous = process.env.SDR_TEST_SECRET;
  const previousKey = process.env.EXAMPLE_API_KEY;
  const previousOptions = process.env.NODE_OPTIONS;
  const previousReport = process.env.FFREPORT, previousGenericReport = process.env.REPORT;
  try {
    process.env.SDR_TEST_SECRET = 'must-not-leave-process';
    process.env.EXAMPLE_API_KEY = 'must-not-leave-process';
    process.env.NODE_OPTIONS = '--trace-warnings';
    process.env.FFREPORT = 'file=outside-project.log'; process.env.REPORT = 'outside-project.log';
    const env = cleanDemoEnvironment(root);
    assert.equal(env.SDR_TEST_SECRET, undefined); assert.equal(env.EXAMPLE_API_KEY, undefined);
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.TEMP, root);
    assert.equal(env.FFREPORT, undefined); assert.equal(env.REPORT, undefined);
  } finally {
    for (const [key, value] of [['SDR_TEST_SECRET', previous], ['EXAMPLE_API_KEY', previousKey],
      ['NODE_OPTIONS', previousOptions], ['FFREPORT', previousReport], ['REPORT', previousGenericReport]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  await assert.rejects(runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'],
    { cwd: root, env: cleanDemoEnvironment(root), limit: 100 }), /demo_child_output_limit/);
  await assert.rejects(runBounded(process.execPath, ['-e', 'setTimeout(()=>{},5000)'],
    { cwd: root, env: cleanDemoEnvironment(root), timeout: 20 }), /demo_child_timeout/);
});

test('preview evidence refuses short decoded audio, missing duration, NaN and zero-energy claims', () => {
  const valid = { sampleCount: 144000, previewEnergy: 1, targetEnergy: 1, product: 0.999,
    durationSeconds: 3 };
  assert.equal(validatePreviewEvidence(valid), 0.999);
  for (const change of [{ sampleCount: 143999 }, { sampleCount: 145025 }, { previewEnergy: 0 },
    { previewEnergy: NaN }, { targetEnergy: 0 }, { targetEnergy: Infinity }, { product: NaN },
    { product: Infinity }, { durationSeconds: undefined }, { durationSeconds: NaN },
    { durationSeconds: 0 }, { durationSeconds: 3.2 }, { product: 2 }, { product: 0.5 }]) {
    assert.throws(() => validatePreviewEvidence({ ...valid, ...change }), /demo_preview_evidence_invalid/);
  }
});

async function assertEpisode(directory) {
  const report = JSON.parse(await readFile(path.join(directory, 'episode-report.json'), 'utf8'));
  assert.equal(report.status, 'technical_ok');
  assert.equal(report.kind, 'synthetic_fixed_plan_rendering_demo');
  assert.equal(report.creative_review, 'not_performed'); assert.equal(report.production_approval, false);
  assert.equal(report.measurements.bgm.duration_samples, 144000);
  for (const name of ['bgm', 'sfx', 'ambience', 'accompaniment', 'original', 'final_mix', 'preview']) {
    assert.equal(report.measurements[name].non_silent, true);
    assert.ok(report.measurements[name].sample_peak_linear < 1);
  }
  assert.ok(report.checks.original_plus_accompaniment_once_max_error < 2 / 8388608);
  assert.ok(Math.abs(report.checks.dialogue_proxy_ducking_db + 10) < 0.1);
  assert.ok(report.checks.preview_final_mix_correlation > 0.98);
  assert.ok(report.checks.first_sfx_sample >= 72000 && report.checks.first_sfx_sample <= 72004);
  assert.ok(report.checks.video_cut.decoded_rgb_mean_absolute_difference > 20);
  assert.notEqual(report.checks.video_cut.before_sha256, report.checks.video_cut.after_sha256);
  for (const [relative, expected] of Object.entries(report.artifacts)) {
    assert.equal(path.isAbsolute(relative), false);
    const bytes = await readFile(path.join(directory, relative));
    assert.equal(bytes.length, expected.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256);
  }
  // Independent test-side decode confirms the delivered stem duration and exact
  // original-once composition, rather than merely trusting the worker's booleans.
  const decode = async relative => {
    const { stdout } = await runBounded('ffmpeg', ['-v', 'error', '-nostdin', '-i', path.join(directory, relative),
      '-map', '0:a:0', '-ar', '48000', '-ac', '2', '-f', 'f32le', 'pipe:1'],
    { cwd: root, env: cleanDemoEnvironment(root) });
    return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length));
  };
  const original = await decode('original.wav'), accompaniment = await decode('render/accompaniment.wav');
  const mixed = await decode('final-mix.wav');
  assert.equal(original.length, 288000); assert.equal(accompaniment.length, original.length);
  assert.equal(mixed.length, original.length);
  let maximum = 0;
  for (let i = 0; i < mixed.length; i++) maximum = Math.max(maximum,
    Math.abs(mixed[i] - accompaniment[i] - original[i]));
  assert.ok(maximum < 2 / 8388608);
}

test('single-episode public CLI really renders non-silent stems, retained proxy and playable preview', async () => {
  const directory = location('single');
  const result = JSON.parse((await cli(['--out', directory, '--episodes', '1'])).stdout.toString());
  assert.equal(result.status, 'technical_ok'); assert.equal(result.output, directory);
  const report = JSON.parse(await readFile(path.join(directory, 'demo-report.json'), 'utf8'));
  assert.equal(report.episodes.length, 1); assert.equal(report.episodes[0].preview, 'episode-01/preview.mp4');
  await assertEpisode(path.join(directory, 'episode-01'));
});

test('default two-episode runner creates a fresh project output and executes strictly in order', async () => {
  const events = [];
  const result = await runOfflineDemo({}, { runEpisode: async options => {
    events.push(`start-${options.index}`);
    const report = await runEpisodeWorker(options);
    events.push(`end-${options.index}`); return report;
  } });
  assert.equal(path.dirname(result.outputDirectory), await import('node:fs/promises').then(fs => fs.realpath(state)));
  assert.match(path.basename(result.outputDirectory), /^demo-/);
  assert.equal(result.report.status, 'technical_ok');
  assert.deepEqual(events, ['start-1', 'end-1', 'start-2', 'end-2']);
  await assertEpisode(path.join(result.outputDirectory, 'episode-02'));
});

test('failed first episode does not prevent second real render; failure report stays inspectable', async () => {
  const directory = location('failure-isolation');
  const result = await runOfflineDemo({ out: directory }, { runEpisode: async options => {
    if (options.index === 1) throw new Error('private token should not appear in public reports');
    return runEpisodeWorker(options);
  } });
  assert.equal(result.report.status, 'failed');
  assert.deepEqual(result.report.episodes.map(row => row.status), ['failed', 'technical_ok']);
  assert.equal(result.report.episodes[0].error, 'demo_episode_failed');
  const saved = await readFile(path.join(directory, 'demo-report.json'), 'utf8');
  assert.equal(saved.includes('private token'), false);
  await assertEpisode(path.join(directory, 'episode-02'));
  // A real executable failure must surface as a nonzero CLI result and persist its report.
  const failedCli = location('missing-runtime');
  const environment = { ...cleanDemoEnvironment(root), PATH: '' };
  await assert.rejects(runBounded(process.execPath, [path.join(PROJECT_ROOT, 'tools/demo-offline.mjs'),
    '--out', failedCli, '--episodes', '1'], { cwd: root, env: environment, timeout: 60000 }),
  /demo_child_failed_exit_1/);
  const failed = JSON.parse(await readFile(path.join(failedCli, 'demo-report.json'), 'utf8'));
  assert.equal(failed.status, 'failed'); assert.equal(failed.episodes[0].status, 'failed');
});
