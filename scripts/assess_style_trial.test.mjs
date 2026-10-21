import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { assessStyleTrial } from './assess_style_trial.mjs';

const execute = promisify(execFile);
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
let directory, baseline, counter = 0;
const bind = async name => ({ path: path.join(directory, name), sha256: await hash(path.join(directory, name)) });
const save = async (name, value) => writeFile(path.join(directory, name), JSON.stringify(value), 'utf8');
const run = async trial => {
  const file = `trial-${++counter}.json`;
  await save(file, trial);
  return assessStyleTrial(path.join(directory, file));
};
before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'short-drama-style-test-'));
  for (const [name, color] of [['video.mp4', 'black'], ['recut.mp4', 'white']]) {
    await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=${color}:s=32x32:r=25:d=2`,
      '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(directory, name)], { windowsHide: true });
  }
  for (const [name, frequency] of [['a.wav', 320], ['b.wav', 480]]) {
    await execute('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=2`,
      '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', path.join(directory, name)], { windowsHide: true });
  }
  const video = await bind('video.mp4');
  await save('analysis.json', { source_video_sha256: video.sha256, observation: 'Synthetic pipeline fixture; no aesthetic claim.' });
  baseline = { schema_version: 1, video: { ...video, window: { start_seconds: 0, end_seconds: 2 } },
    analysis: await bind('analysis.json'),
    policy: { comparison: 'style', selection: 'director_auto', require_music_words: false },
    recommended_candidate_id: 'a', selected_candidate_id: null, candidates: [] };
  for (const id of ['a', 'b']) baseline.candidates.push({ id,
    source: { ...await bind(`${id}.wav`), range: { start_seconds: 0, end_seconds: 2 }, family: `fixture:${id}` },
    audition: await bind(`${id}.wav`), music_form: 'instrumental', content_review: { status: 'pending' } });
});
after(async () => {
  if (directory) {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('short-drama-style-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an instrumental or wordless trial exposes the requested music-words gap', async () => {
  const trial = structuredClone(baseline);
  trial.policy.require_music_words = true;
  trial.candidates[1].music_form = 'wordless_vocal';
  const report = await run(trial);
  assert.equal(report.structure_valid, true);
  assert.equal(report.status, 'candidate_gaps');
  assert.equal(report.candidates_ready, false);
  assert.equal(report.next_candidate_id, null);
  assert.ok(report.gaps.some(g => g.code === 'verified_music_words_candidate_missing'));
});

test('renaming identical audio cannot create a style comparison; arrangement comparison is allowed', async () => {
  const trial = structuredClone(baseline);
  await copyFile(trial.candidates[0].source.path, path.join(directory, 'renamed.wav'));
  trial.candidates[1].source = { ...trial.candidates[1].source, ...await bind('renamed.wav') };
  const style = await run(trial);
  assert.equal(style.status, 'candidate_gaps');
  assert.equal(style.next_candidate_id, null);
  assert.ok(style.gaps.some(g => g.code === 'same_source_or_family_is_not_style_comparison'));
  trial.policy.comparison = 'arrangement';
  assert.equal((await run(trial)).status, 'ready_for_short_audition');
});

test('a valid replacement video cannot reuse analysis of the old edit', async () => {
  const trial = structuredClone(baseline);
  trial.video = { ...trial.video, ...await bind('recut.mp4') };
  const report = await run(trial);
  assert.equal(report.status, 'invalid_trial');
  assert.equal(report.next_candidate_id, null);
  assert.ok(report.issues.some(i => i.code === 'analysis_video_identity_mismatch'));
});

test('director-auto produces an audition without a mandatory user vote or artistic pass', async () => {
  const trial = structuredClone(baseline);
  trial.artistic_acceptance = 'passed';
  trial.candidates[0].listening_acceptance = 'passed';
  const report = await run(trial);
  assert.equal(report.status, 'ready_for_short_audition');
  assert.equal(report.next_candidate_id, 'a');
  assert.equal(report.artistic_acceptance, 'not_assessed');
  assert.equal(report.production_approval, false);
  assert.ok(report.candidates.every(c => c.listening_acceptance === 'not_assessed'));
  assert.ok(report.warnings.some(w => w.code === 'content_listening_pending'));
});

test('explicit user-choice mode waits for a real recorded choice', async () => {
  const trial = structuredClone(baseline);
  trial.policy.selection = 'user_choose';
  const waiting = await run(trial);
  assert.equal(waiting.status, 'awaiting_user_selection');
  assert.equal(waiting.next_candidate_id, null);
  trial.selected_candidate_id = 'b';
  const selected = await run(trial);
  assert.equal(selected.status, 'ready_for_short_audition');
  assert.equal(selected.next_candidate_id, 'b');
});

test('words need a bound review record; even that record does not grant artistic approval', async () => {
  const trial = structuredClone(baseline), candidate = trial.candidates[1];
  trial.policy.require_music_words = true;
  candidate.music_form = 'spoken_adlib';
  assert.equal((await run(trial)).status, 'candidate_gaps');
  const evidence = { source_sha256: candidate.source.sha256, source_range_seconds: [0, 2],
    music_form: 'spoken_adlib', observation: 'Contract fixture only: this record is not an actual audio-language verification.' };
  await save('content.json', evidence);
  candidate.content_review = { status: 'verified', evidence: await bind('content.json') };
  trial.recommended_candidate_id = 'b';
  const recorded = await run(trial);
  assert.equal(recorded.status, 'ready_for_short_audition');
  assert.equal(recorded.content_review_scope, 'records_checked_not_independently_listened');
  assert.equal(recorded.artistic_acceptance, 'not_assessed');
  evidence.source_sha256 = trial.candidates[0].source.sha256;
  await save('wrong-content.json', evidence);
  candidate.content_review.evidence = await bind('wrong-content.json');
  const mismatched = await run(trial);
  assert.equal(mismatched.status, 'invalid_trial');
  assert.equal(mismatched.next_candidate_id, null);
  assert.ok(mismatched.issues.some(i => i.code === 'content_evidence_not_bound_to_selected_source'));
});

test('a verified words option cannot authorize choosing a different instrumental candidate', async () => {
  const trial = structuredClone(baseline), candidate = trial.candidates[1];
  trial.policy.require_music_words = true;
  candidate.music_form = 'short_lyrics';
  await save('chosen-words.json', { source_sha256: candidate.source.sha256, source_range_seconds: [0, 2],
    music_form: 'short_lyrics', observation: 'Contract fixture only; not a real singing verification.' });
  candidate.content_review = { status: 'verified', evidence: await bind('chosen-words.json') };
  const wrongAuto = await run(trial);
  assert.equal(wrongAuto.status, 'candidate_gaps');
  assert.equal(wrongAuto.next_candidate_id, null);
  assert.ok(wrongAuto.gaps.some(g => g.code === 'chosen_music_words_candidate_missing' && g.candidate_id === 'a'));
  trial.selected_candidate_id = 'b';
  assert.equal((await run(trial)).next_candidate_id, 'b');
  trial.policy.selection = 'user_choose';
  trial.selected_candidate_id = null;
  assert.equal((await run(trial)).status, 'awaiting_user_selection');
  trial.selected_candidate_id = 'a';
  assert.equal((await run(trial)).status, 'candidate_gaps');
  trial.selected_candidate_id = 'b';
  assert.equal((await run(trial)).status, 'ready_for_short_audition');
});
