import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {probeCommand, requiredFilters, requiredEncoders, runDoctor, runDoctorCli} from '../tools/doctor.mjs';

const healthyProbe = async (command, args) => ({ok: true, stdout: args.includes('-version')
  ? `${command} version 6.1.1 Copyright public build\n`
  : (args.includes('-filters') ? requiredFilters : requiredEncoders)
    .map(name => ` ... ${name} A->A public test entry`).join('\n')});
const healthy = options => runDoctor({nodeVersion: 'v24.19.0', probe: healthyProbe, ...options});
const row = (report, id) => report.checks.find(item => item.id === id);

test('doctor without a deployment remains offline-ready and never probes Python or models', async () => {
  const calls = [];
  const report = await healthy({probe: async (...args) => { calls.push(args); return healthyProbe(...args); }});
  assert.equal(report.ok, true);
  assert.equal(report.offline_ready, true);
  assert.equal(report.automatic_readiness, 'unverified');
  assert.ok(report.automatic_checks.every(item => item.status === 'not_checked'));
  assert.equal(report.profile_checked, false);
  assert.equal(row(report, 'python').status, 'optional');
  assert.deepEqual(calls.map(([command, args]) => [command, ...args]), [
    ['ffmpeg', '-version'], ['ffprobe', '-version'],
    ['ffmpeg', '-hide_banner', '-filters'], ['ffmpeg', '-hide_banner', '-encoders'],
  ]);
});

test('doctor enforces the exact stable Node 24.19.0+ 24.x range', async () => {
  for (const version of ['v24.19.0', '24.20.1', 'v24.99.0']) assert.equal((await healthy({nodeVersion: version})).ok, true, version);
  for (const version of ['v24.18.9', 'v23.99.0', 'v25.0.0', 'v24.19.0-rc.1', 'v024.19.0', '24.19', '', null, 'credential=private']) {
    const report = await healthy({nodeVersion: version});
    assert.equal(report.ok, false, String(version));
    assert.equal(report.offline_ready, false);
    assert.equal(row(report, 'node').status, 'failed');
    assert.equal(JSON.stringify(report).includes('credential='), false);
  }
});

test('doctor fails missing executables, malformed versions and probe failures with safe action hints', async () => {
  for (const badCommand of ['ffmpeg', 'ffprobe']) {
    const report = await healthy({probe: (command, args) => command === badCommand
      ? {ok: false, reason: 'missing_command', stderr: 'PRIVATE_TOKEN_DO_NOT_PRINT'} : healthyProbe(command, args)});
    assert.equal(report.ok, false);
    assert.equal(report.offline_ready, false);
    assert.match(row(report, badCommand).action, /PATH/);
    assert.equal(JSON.stringify(report).includes('PRIVATE_TOKEN_DO_NOT_PRINT'), false);
  }
  const malformed = await healthy({probe: async () => ({ok: true, stdout: 'untrusted SECRET_KEY output'})});
  assert.equal(malformed.ok, false);
  assert.equal(JSON.stringify(malformed).includes('SECRET_KEY'), false);
  const privateVersion = await healthy({probe: async (command) => ({ok: true,
    stdout: `${command} version PRIVATE_TOKEN_DO_NOT_PRINT`})});
  assert.equal(privateVersion.ok, false);
  assert.equal(JSON.stringify(privateVersion).includes('PRIVATE_TOKEN_DO_NOT_PRINT'), false);
  const thrown = await healthy({probe: async () => { throw Error('PRIVATE_TOKEN_DO_NOT_PRINT'); }});
  assert.equal(thrown.ok, false);
  assert.equal(JSON.stringify(thrown).includes('PRIVATE_TOKEN_DO_NOT_PRINT'), false);
  for (const reason of ['timeout', 'output_limit', 'command_failed']) {
    const report = await healthy({probe: async () => ({ok: false, reason})});
    assert.equal(row(report, 'ffmpeg').detail.reason, reason);
    assert.ok(row(report, 'ffmpeg').action.length);
  }
});

test('doctor detects missing required filters and encoders, not substrings in descriptions', async () => {
  for (const [flag, id, names] of [['-filters', 'ffmpeg_filters', requiredFilters], ['-encoders', 'ffmpeg_encoders', requiredEncoders]]) {
    const report = await healthy({probe: async (command, args) => args.includes(flag)
      ? {ok: true, stdout: ` ... unrelated A->A description mentions ${names.join(' ')}`} : healthyProbe(command, args)});
    assert.equal(report.ok, false);
    assert.deepEqual(row(report, id).detail.missing, [...names]);
  }
  const newFfmpegFormat = await healthy({probe: async (command, args) => args.includes('-filters')
    ? {ok: true, stdout: requiredFilters.map(name => ` .. ${name} A->A new flag format`).join('\n')}
    : args.includes('-encoders')
      ? {ok: true, stdout: requiredEncoders.map(name => ` A....D ${name} encoder`).join('\n')}
      : healthyProbe(command, args)});
  assert.equal(newFfmpegFormat.ok, true);
});

test('profile is opt-in, absolute, bounded, read-only and only validates existing bindings', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'w-score-doctor-'));
  try {
    const profile = path.join(directory, 'profile.json'), publication = path.join(directory, 'publication.json');
    // This deliberately minimal fixture proves only the loader's existing binding seam.
    // It is not a usable deployment, material qualification, authorization or production approval.
    const consumer = {strategy: 'public_fixture', cases: {fixture: true}, library: {fixture: true}};
    const content = JSON.stringify({consumer});
    await writeFile(publication, content);
    const value = {schema_version: 1, mode: 'research', automatic_trial: true, ...consumer,
      consumer_publication: {path: publication, sha256: createHash('sha256').update(content).digest('hex')}};
    await writeFile(profile, JSON.stringify(value));
    const before = await readdir(directory), original = await readFile(profile, 'utf8');
    const report = await healthy({profilePath: profile});
    assert.equal(report.ok, true);
    assert.equal(report.automatic_readiness, 'unverified');
    assert.ok(report.automatic_checks.every(item => item.status === 'not_checked'));
    assert.equal(row(report, 'deployment_profile').status, 'passed');
    assert.deepEqual(await readdir(directory), before);
    assert.equal(await readFile(profile, 'utf8'), original);
    assert.equal(JSON.stringify(report).includes(directory), false);
    await writeFile(publication, JSON.stringify({consumer: {...consumer, strategy: 'changed'}}));
    assert.equal(row(await healthy({profilePath: profile}), 'deployment_profile').status, 'failed');
    for (const file of ['relative.json', path.join(directory, 'missing.json'), directory]) {
      const invalid = await healthy({profilePath: file});
      assert.equal(invalid.ok, false);
      assert.equal(invalid.offline_ready, true);
      assert.ok(invalid.automatic_checks.every(item => item.status === 'not_checked'));
      assert.equal(row(invalid, 'deployment_profile').status, 'failed');
    }
    for (const content of ['{ broken JSON PRIVATE_TOKEN_DO_NOT_PRINT', '{}', JSON.stringify({secret: 'PRIVATE_TOKEN_DO_NOT_PRINT'}), ' '.repeat(1024 * 1024 + 1)]) {
      await writeFile(profile, content);
      const invalid = await healthy({profilePath: profile});
      assert.equal(invalid.ok, false);
      assert.equal(invalid.offline_ready, true);
      assert.equal(JSON.stringify(invalid).includes('PRIVATE_TOKEN_DO_NOT_PRINT'), false);
      assert.equal(JSON.stringify(invalid).includes(directory), false);
    }
  } finally {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.match(path.basename(resolved), /^w-score-doctor-/);
    await rm(resolved, {recursive: true, force: true});
  }
});

test('doctor CLI help has no probes; arguments fail safely and JSON exit status agrees with checks', async () => {
  let output = '', calls = 0;
  const write = value => { output += value; };
  const forbiddenProbe = async () => { calls++; throw Error('should not run'); };
  assert.equal(await runDoctorCli(['--help'], {write, probe: forbiddenProbe}), 0);
  assert.match(output, /用法/);
  assert.equal(calls, 0);
  for (const args of [['--unknown', 'PRIVATE_TOKEN_DO_NOT_PRINT'], ['--profile'], ['--profile', 'relative.json'],
    ['positional'], ['--profile', path.resolve('one.json'), '--profile', path.resolve('two.json')]]) {
    output = '';
    assert.equal(await runDoctorCli([...args, '--json'], {write, probe: forbiddenProbe}), 1);
    assert.equal(JSON.parse(output).ok, false);
    assert.equal(output.includes('PRIVATE_TOKEN_DO_NOT_PRINT'), false);
    assert.equal(calls, 0);
  }
  output = '';
  assert.equal(await runDoctorCli(['--json'], {write, probe: healthyProbe, nodeVersion: 'v24.19.0'}), 0);
  assert.equal(JSON.parse(output).offline_ready, true);
  output = '';
  assert.equal(await runDoctorCli(['--json'], {write, probe: healthyProbe, nodeVersion: 'v25.0.0'}), 1);
  assert.equal(JSON.parse(output).ok, false);
});

test('bounded command probe handles real missing commands, timeout, excessive output and shell metacharacters', async () => {
  assert.equal((await probeCommand('w-auto-score-nonexistent-executable', [])).reason, 'missing_command');
  assert.equal((await probeCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeoutMs: 100})).reason, 'timeout');
  assert.equal((await probeCommand(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], {maxOutputBytes: 256})).reason, 'output_limit');
  const literal = 'safe & echo SHOULD_NOT_EXECUTE';
  const result = await probeCommand(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, literal);
});

test('command probes remove FFREPORT and sensitive child variables without mutating the parent', async () => {
  const keys = ['FFREPORT', 'OPENAI_DOCTOR_FIXTURE', 'DOCTOR_API_KEY', 'NODE_OPTIONS'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'SYNTHETIC_PRIVATE_FIXTURE';
    const result = await probeCommand(process.execPath, ['-e',
      `process.stdout.write(JSON.stringify(${JSON.stringify(keys)}.map(key=>process.env[key]??null)))`]);
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.stdout), keys.map(() => null));
    for (const key of keys) assert.equal(process.env[key], 'SYNTHETIC_PRIVATE_FIXTURE');
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
