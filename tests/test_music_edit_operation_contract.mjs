import test from 'node:test';
import assert from 'node:assert/strict';
import { compileEdit, editSchema, editSchemaV2 } from '../scripts/compose_episode.mjs';
import { researchAssemblySchema } from '../scripts/assemble_research_episode.mjs';
import { validateSchema } from '../scripts/audio_api.mjs';
import { actionTasksCover, extendGainEnvelope } from '../scripts/music_edit_operation_contract.mjs';
import { auditMusicActionExecution, verifyMusicActionRenderExecution } from '../scripts/music_action_execution_audit.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareEpisode } from '../scripts/prepare_episode.mjs';
import { renderPlan } from '../scripts/render_audio.mjs';
import { hashFile } from '../scripts/render_binding.mjs';

const SHA = 'a'.repeat(64), AUDIO = 'b'.repeat(64), SECOND = 'c'.repeat(64);
function fixture({ pieces = [[0, 5], [5, 10]], sourceStarts = [0, 5], gains = [-12, -12], kind = 'hold', anchor = null } = {}) {
  const ids = pieces.map((_, i) => `mother/arc/arc/p${i}`);
  const sources = pieces.map((target, i) => ({ asset_id: 'music', local_path: 'synthetic.wav', source_sha256: AUDIO,
    source_range: [sourceStarts[i], sourceStarts[i] + target[1] - target[0]] }));
  const plan = { schema_version: 2, source_video_sha256: SHA, arcs: [{ arc_id: 'arc', cue_id: 'mother', pieces: pieces.map((target, i) => ({
    piece_id: 'p' + i, target_range: target, source_window: { ...sources[i], segment_id: 'music', candidate_source_range: [0, 40] },
    connection_from: i ? { previous_piece_id: 'p' + (i - 1), type: 'cut', overlap_seconds: 0,
      from_source_handle_range: null, to_source_handle_range: null, fade_curve: 'linear', reason: 'Synthetic test connection.' } : null,
    development_role: 'Synthetic contract only.', silence_reason: null })) }] };
  const action = { id: 'change', story_beat_id: 'beat', target_range: [0, 10], requirement: kind === 'hold' ? 'hold' : 'response', intent: 'Synthetic action.' };
  const edits = { schema_version: 2,
    music_edits: ids.map((id, i) => ({ music_task_cue_id: id, gain_db: gains[i], gain_envelope: null,
      fade_in_seconds: 0, fade_out_seconds: 0, transition_reason: 'Actual synthetic renderer operand.' })),
    action_responses: [{ action_id: 'change', music_task_cue_id: ids[0], music_task_cue_ids: ids,
      target_range: action.target_range, response_kind: kind === 'hold' ? 'hold' : kind === 'source_development' ? 'source_development' : 'edit_operation',
      reason: 'Synthetic execution contract; no hearing qualification.', actual_edit_operation: { kind, anchor_seconds: anchor } }],
    sounds: [], dialogue_ducking_db: 0, uncertainties: [] };
  const tasks = { cues: ids.map((id, i) => ({ cue_id: id, target_range: pieces[i] })) };
  return { director: { source_video_sha256: SHA, cues: [{ cue_id: 'mother', required_action_ids: ['change'] }], music_actions: [action] },
    plan, edits, compile: { edits, tasks, routes: { cues: ids.map((id, i) => ({ cue_id: id, selected: sources[i] })) },
      analysis: { original_audio: { kind: 'none' }, sound_events: [], sound_event_none_reason: 'Synthetic test.', story_beats: [] },
      manifestPath: 'manifest.json', duration: 10, audience: 'auto', craftMode: 'fine', evidence: { refs: new Map(), sounds: [] }, dialogueIntervals: [] } };
}
function audited(value) {
  const compiled = compileEdit(value.compile);
  return { compiled, audit: auditMusicActionExecution({ director: value.director, plan: value.plan, edits: value.edits, compiled }) };
}

test('the new operation schema is opt-in and cannot mutate or silently upgrade legacy edits', () => {
  const old = structuredClone(editSchema), value = fixture().edits;
  assert.doesNotThrow(() => validateSchema(value, editSchemaV2));
  assert.throws(() => validateSchema(value, editSchema), /extra_field/);
  assert.deepEqual(researchAssemblySchema({}).properties.edits, old);
  assert.deepEqual(researchAssemblySchema({ music_action_contract_version: 2 }).properties.edits, editSchemaV2);
  assert.deepEqual(editSchema, old);
  value.schema_version = 3; assert.throws(() => validateSchema(value, editSchemaV2), /enum_invalid/);
});

test('a complete action can span actual pieces, with exact source positions and no invented audio approval', () => {
  const value = fixture(), { audit, compiled } = audited(value);
  assert.equal(compiled.actionResponses[0].plan_piece_mappings.length, 2);
  assert.equal(compiled.actionResponses[0].source_range, null);
  assert.equal(audit.actions[0].status, 'executed_hold');
  assert.equal(audit.actions[0].execution_evidence.actual_piece_mappings.length, 2);
  assert.equal(audit.actual_audio_hearing_performed, false); assert.equal(audit.production_approval, false);
  assert.equal(auditMusicActionExecution({ director: value.director, plan: value.plan, edits: value.edits }).actions[0].status, 'unresolved');
  const bad = structuredClone(value.edits.action_responses[0]); bad.music_task_cue_ids.pop();
  assert.equal(actionTasksCover(bad, value.director.music_actions[0], value.compile.tasks.cues, 2), false);
});

test('a real same-recording source-position switch is distinct from uninterrupted source playback', () => {
  const value = fixture({ sourceStarts: [0, 20], kind: 'source_switch', anchor: 5 });
  assert.equal(audited(value).audit.actions[0].status, 'executed_edit');
  value.compile.routes.cues[1].selected.source_range = [5, 10];
  value.plan.arcs[0].pieces[1].source_window.source_range = [5, 10];
  assert.equal(audited(value).audit.actions[0].status, 'unresolved');
  value.compile.routes.cues[1].selected.source_range = [20, 25];
  // A renderer source disagreeing with the supplied actual piece is rejected.
  assert.match(audited(value).audit.actions[0].reason, /source_position_changed/);
});

test('gain changes and real automation can be executed without pretending to prove source orchestration', () => {
  const step = fixture({ gains: [-12, -6], kind: 'gain_change', anchor: 5 });
  assert.equal(audited(step).audit.actions[0].status, 'executed_edit');
  const curve = fixture({ pieces: [[0, 10]], sourceStarts: [0], gains: [-12], kind: 'gain_envelope' });
  curve.edits.music_edits[0].gain_envelope = [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 10, gain_db: 6 }];
  const result = audited(curve);
  assert.deepEqual(result.compiled.plan.cues[0].gain_envelope, curve.edits.music_edits[0].gain_envelope);
  assert.equal(result.audit.actions[0].status, 'executed_edit');
  curve.edits.action_responses[0].actual_edit_operation.kind = 'source_development';
  curve.edits.action_responses[0].response_kind = 'source_development';
  curve.edits.action_responses[0].source_development_evidence = { approved: true, local_growth: true };
  assert.equal(audited(curve).audit.actions[0].status, 'unresolved');
  assert.equal(audited(curve).audit.actions[0].source_development_evidence, null);
  curve.edits.music_edits[0].gain_envelope[1].offset_seconds = 9;
  assert.throws(() => compileEdit(curve.compile), /exact_task/);
});

test('real crossfade handle extension preserves the authored curve on its original source clock', () => {
  const authored = [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 2, gain_db: 3 }, { offset_seconds: 5, gain_db: 0 }];
  assert.deepEqual(extendGainEnvelope(authored, 5, -12, .2, .3), [
    { offset_seconds: 0, gain_db: 0 }, { offset_seconds: .2, gain_db: 0 },
    { offset_seconds: 2.2, gain_db: 3 }, { offset_seconds: 5.2, gain_db: 0 }, { offset_seconds: 5.5, gain_db: 0 }]);
  assert.deepEqual(authored[1], { offset_seconds: 2, gain_db: 3 });
});

test('a declared accent requires a real bounded peak instead of positive gain or a label', () => {
  const value = fixture({ pieces: [[0, 10]], sourceStarts: [0], gains: [-12], kind: 'accent', anchor: 5 });
  value.edits.music_edits[0].gain_envelope = [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 4, gain_db: 0 },
    { offset_seconds: 5, gain_db: 4 }, { offset_seconds: 6, gain_db: 0 }, { offset_seconds: 10, gain_db: 0 }];
  const result = audited(value);
  assert.equal(result.audit.actions[0].status, 'executed_edit');
  assert.equal(result.audit.actions[0].execution_evidence.musical_accent_verified, false);
  value.edits.music_edits[0].gain_envelope = null; value.edits.music_edits[0].gain_db = 2;
  assert.equal(audited(value).audit.actions[0].status, 'unresolved');
});

test('actual words-input entry and automation retain correct mapping around a replaced phrase', () => {
  const value = fixture({ pieces: [[0, 10]], sourceStarts: [0], gains: [-12], kind: 'lyric_entry', anchor: 3 });
  const id = value.compile.tasks.cues[0].cue_id, wordsId = id + '/words';
  value.compile.tasks.cues.push({ cue_id: wordsId, parent_cue_id: id, target_range: [3, 6], music_role: 'words_candidate', words_mode: 'song_replace' });
  value.compile.routes.cues.push({ cue_id: wordsId, selected: { asset_id: 'words', local_path: 'synthetic-words.wav', source_sha256: SECOND, source_range: [20, 23] } });
  value.edits.music_edits[0].gain_envelope = [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 10, gain_db: 10 }];
  value.edits.music_edits.push({ ...value.edits.music_edits[0], music_task_cue_id: wordsId, gain_envelope: null });
  value.edits.action_responses[0].music_task_cue_ids.push(wordsId);
  const { compiled, audit } = audited(value);
  assert.equal(audit.actions[0].status, 'executed_edit');
  assert.equal(audit.actions[0].execution_evidence.lyric_content_verified, false);
  assert.deepEqual(compiled.plan.cues.find(cue => cue.id === id + '#2').gain_envelope,
    [{ offset_seconds: 0, gain_db: 6 }, { offset_seconds: 4, gain_db: 10 }]);
  assert.equal(compiled.actionResponses[0].plan_piece_mappings.length, 3);
});

test('render execution evidence must match actual source/gain/envelope placements and hashes', () => {
  const value = fixture(), { compiled, audit } = audited(value);
  // Synthetic report is explicitly an engineering fixture, not real listening.
  const report = { source_sha256: SHA, sample_rate: 48000, duration_samples: 480000,
    input_binding: { asset_sha256: { music: AUDIO } }, output_sha256: { bgm: 'd'.repeat(64) },
    cues: compiled.plan.cues.map(cue => ({ id: cue.id, track: 'bgm', asset_id: cue.asset_id,
      source_in_sample: Math.round(cue.source_in_seconds * 48000), source_out_sample: Math.round(cue.source_out_seconds * 48000),
      start_sample: Math.round(cue.start_seconds * 48000), end_sample: Math.round((cue.start_seconds + cue.source_out_seconds - cue.source_in_seconds) * 48000),
      gain_db: cue.gain_db, fade_in_samples: 0, fade_out_samples: 0, fade_curve: 'raised_cosine', gain_envelope: null })) };
  assert.equal(verifyMusicActionRenderExecution(audit, compiled, report).rendered_audio_execution_verified, true);
  report.cues[0].gain_db += 1;
  assert.throws(() => verifyMusicActionRenderExecution(audit, compiled, report), /placement_or_source_mismatch/);
  report.cues[0].gain_db -= 1; report.input_binding.asset_sha256.music = SECOND;
  assert.throws(() => verifyMusicActionRenderExecution(audit, compiled, report), /placement_or_source_mismatch/);
});

test('a normal editor envelope reaches the real PCM renderer and creates the measured local amplitude change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'music-operation-pcm-'));
  try {
    const video = path.join(root, 'synthetic.mp4'), music = path.join(root, 'synthetic-music.wav');
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=navy:s=64x64:r=10:d=10',
      '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '10', '-c:v', 'libx264', '-c:a', 'aac', video], { windowsHide: true });
    execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10',
      '-ac', '2', '-c:a', 'pcm_s24le', music], { windowsHide: true });
    await prepareEpisode({ video, out: path.join(root, 'prepared'), step: 2 });
    const value = fixture({ pieces: [[0, 10]], sourceStarts: [0], gains: [-12], kind: 'accent', anchor: 5 });
    const sourceSha = await hashFile(video), musicSha = await hashFile(music);
    value.director.source_video_sha256 = sourceSha; value.plan.source_video_sha256 = sourceSha;
    value.plan.arcs[0].pieces[0].source_window.source_sha256 = musicSha;
    Object.assign(value.compile.routes.cues[0].selected, { local_path: music, source_sha256: musicSha });
    value.compile.manifestPath = path.join(root, 'prepared/manifest.json');
    value.edits.music_edits[0].gain_envelope = [{ offset_seconds: 0, gain_db: 0 }, { offset_seconds: 4, gain_db: 0 },
      { offset_seconds: 5, gain_db: 4 }, { offset_seconds: 6, gain_db: 0 }, { offset_seconds: 10, gain_db: 0 }];
    const { audit, compiled } = audited(value), planFile = path.join(root, 'plan.json'), out = path.join(root, 'render');
    await writeFile(planFile, JSON.stringify(compiled.plan));
    const report = await renderPlan(planFile, out, { cwd: root }), verified = verifyMusicActionRenderExecution(audit, compiled, report);
    assert.equal(verified.rendered_audio_execution_verified, true); assert.equal(verified.qualified, false);
    assert.equal(report.duration_samples, 480000); assert.equal(report.bit_depth, 24);
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-nostdin', '-i', path.join(out, 'bgm.wav'),
      '-f', 'f32le', '-acodec', 'pcm_f32le', '-ac', '1', '-ar', '48000', '-'], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const rms = (from, to) => { let sum = 0; for (let i = Math.round(from * 48000); i < Math.round(to * 48000); i++) sum += pcm.readFloatLE(i * 4) ** 2;
      return Math.sqrt(sum / Math.round((to - from) * 48000)); };
    const accentDb = 20 * Math.log10(rms(4.95, 5.05) / rms(1, 1.1));
    assert.ok(accentDb > 3.7 && accentDb < 4.1, 'The real PCM contains the authored accent, not only an audit label.');
    assert.equal((await readFile(path.join(out, 'report.json'))).length > 0, true);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('music-operation-pcm-'));
    await rm(root, { recursive: true, force: true });
  }
});
