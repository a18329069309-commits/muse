import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { compileSoundArcPlan, validateSoundArcSeams, soundArcPlanSchema } from '../scripts/sound_arc_plan.mjs';
import { validateSchema } from '../scripts/audio_api.mjs';

const videoSha = 'a'.repeat(64), sourceSha = 'b'.repeat(64);
let work, ordinal = 0;
before(() => { work = mkdtempSync(join(tmpdir(), 'drama-sound-arcs-')); });
after(() => {
  assert.equal(dirname(resolve(work)), resolve(tmpdir()));
  assert.ok(basename(work).startsWith('drama-sound-arcs-'));
  rmSync(work, { recursive: true, force: true });
});

function fixture() {
  const director = { schema_version: 1, source_video_sha256: videoSha,
    cues: [{ cue_id: 'mother', target_range: [0, 30], function: 'protect-family', sound_goal: 'Pressure then release',
      mode: 'fine', allow_generation: true, expert_ids: ['family'], story_beat_ids: ['event'], required_action_ids: ['reply'],
      query: { function: 'protect-family', min_duration: 30, candidate_segment_ids: ['old'] } }],
    music_actions: [{ id: 'reply', target_range: [22, 25] }] };
  const candidates = [{ cue_id: 'mother', segment_id: 'same-recording', asset_id: 'theme',
    source_sha256: sourceSha, source_range: [0, 100], local_path: 'resolved-by-formal-route.wav' }];
  const pieces = [
    { piece_id: 'pressure', source_window: { segment_id: 'same-recording', asset_id: 'theme', source_sha256: sourceSha,
      candidate_source_range: [0, 100], source_range: [10, 20] }, target_range: [0, 10],
      development_role: 'Hold the threat before the reply', connection_from: null },
    { piece_id: 'turn', source_window: { segment_id: 'same-recording', asset_id: 'theme', source_sha256: sourceSha,
      candidate_source_range: [0, 100], source_range: [40, 50] }, target_range: [10, 20],
      development_role: 'Reveal the changed control', connection_from: { previous_piece_id: 'pressure', reason: 'Use the actual phrase exit and the next entrance' } },
    { piece_id: 'release', source_window: { segment_id: 'same-recording', asset_id: 'theme', source_sha256: sourceSha,
      candidate_source_range: [0, 100], source_range: [75, 85] }, target_range: [20, 30],
      development_role: 'Resolve the family response', connection_from: { previous_piece_id: 'turn', reason: 'Land the response on this distinct release phrase' } },
  ];
  return { director, candidates, plan: { schema_version: 1, source_video_sha256: videoSha,
    arcs: [{ arc_id: 'family', cue_id: 'mother', pieces }] } };
}

function opportunityFixture() {
  const input=fixture();input.plan.schema_version=2;input.director.direction_version=2;
  for(const piece of input.plan.arcs[0].pieces){
    piece.silence_reason=null;
    if(piece.connection_from) Object.assign(piece.connection_from,{type:'cut',overlap_seconds:0,
      from_source_handle_range:null,to_source_handle_range:null,fade_curve:'raised_cosine'});
  }
  Object.assign(input.director.cues[0],{words_candidate_request:'explore',words_target_range:null,
    words_mode:'same_source_development',words_opportunity:{allowed_target_intervals:[[22,30]],anchor_event_ids:['event']}});
  return input;
}

test('v2 bounded lyric exploration compiles music without inventing a selected word window and retains its pending task',()=>{
  const input=opportunityFixture(),before=structuredClone(input),result=compileSoundArcPlan(input);
  assert.deepEqual(input,before);
  assert.equal(result.splitCues.length,3);
  assert.ok(result.splitCues.every(cue=>!('words_candidate_request' in cue)&&!('words_target_range' in cue)&&!('words_opportunity' in cue)));
  assert.deepEqual(result.arcManifest.pending_words_explorations,[{cue_id:'mother',request:'explore',
    allowed_target_intervals:[[22,30]],anchor_event_ids:['event'],status:'exploration_pending_no_selected_phrase',
    lyric_content_approved:false,production_approval:false}]);
  assert.equal(result.production_approval,false);
});

test('required null lyric windows and unbounded or old exploration remain rejected',()=>{
  for(const [mutate,reason] of [
    [input=>{input.director.cues[0].words_candidate_request='require';},/words_request_requires_explicit_target_window/],
    [input=>{delete input.director.cues[0].words_opportunity;},/words_request_requires_explicit_target_window/],
    [input=>{input.director.cues[0].words_opportunity.allowed_target_intervals=[];},/valid_words_exploration_opportunity_required/],
    [input=>{input.director.cues[0].words_opportunity.allowed_target_intervals=[[22,31]];},/valid_words_exploration_opportunity_required/],
    [input=>{input.director.cues[0].words_opportunity.allowed_target_intervals=[[22,22]];},/valid_words_exploration_opportunity_required/],
    [input=>{input.director.cues[0].words_opportunity.allowed_target_intervals=[[NaN,30]];},/valid_words_exploration_opportunity_required/],
    [input=>{input.director.cues[0].words_opportunity.anchor_event_ids=[];},/valid_words_exploration_opportunity_required/],
    [input=>{input.director.cues[0].words_opportunity.anchor_event_ids=['not-current-event'];},/valid_words_exploration_opportunity_required/],
    [input=>{input.director.direction_version=1;},/words_request_requires_explicit_target_window/],
    [input=>{delete input.director.cues[0].words_target_range;},/words_request_requires_explicit_target_window/],
    [input=>{input.plan=fixture().plan;},/words_request_requires_explicit_target_window/],
  ]){const input=opportunityFixture();mutate(input);assert.throws(()=>compileSoundArcPlan(input),reason);}
});

test('explicit empty words supply keeps a proposed explore window pending across music pieces without rewriting the mother', () => {
  const input = opportunityFixture(); input.director.cues[0].words_target_range = [22, 30];
  input.wordsCandidates = []; const before = structuredClone(input), result = compileSoundArcPlan(input);
  assert.deepEqual(input, before);
  assert.deepEqual(result.arcManifest.arcs[0].original_cue, before.director.cues[0]);
  assert.ok(result.splitCues.every(cue => !('words_target_range' in cue) && !('words_candidate_request' in cue)));
  assert.deepEqual(result.arcManifest.pending_words_explorations[0].proposed_target_range, [22, 30]);
  assert.equal(result.arcManifest.pending_words_explorations[0].selected_words_candidate, false);
  assert.equal(result.production_approval, false);
  const legacy = structuredClone(input); delete legacy.wordsCandidates;
  assert.deepEqual(compileSoundArcPlan(legacy).splitCues.at(-1).words_target_range, [22, 30]);
  for (const candidates of [[{ parent_cue_id: 'mother', cue_id: 'mother/words' }], [{ cue_id: 'mother/words' }]]) {
    const selected = structuredClone(input); selected.wordsCandidates = candidates;
    assert.deepEqual(compileSoundArcPlan(selected).splitCues.at(-1).words_target_range, [22, 30]);
  }
  const required = structuredClone(input); required.director.cues[0].words_candidate_request = 'require';
  assert.deepEqual(compileSoundArcPlan(required).splitCues.at(-1).words_target_range, [22, 30]);
  required.plan.arcs[0].pieces.at(-1).source_window = null;
  required.plan.arcs[0].pieces.at(-1).silence_reason = 'Cannot silently replace required words.';
  assert.throws(() => compileSoundArcPlan(required), /words_task_cannot_be_silenced/);
});

test('three explicit windows of the same recording remain three one-window tasks and preserve the mother', () => {
  const input = fixture(), before = structuredClone(input), compiled = compileSoundArcPlan(input);
  assert.equal(compiled.splitCues.length, 3);
  assert.equal(new Set(compiled.splitCues.map(c => c.cue_id)).size, 3);
  assert.deepEqual(compiled.splitCues.map(c => c.requested_candidates[0].source_range), [[10, 20], [40, 50], [75, 85]]);
  assert.deepEqual(compiled.splitCues.map(c => c.target_range), [[0, 10], [10, 20], [20, 30]]);
  assert.ok(compiled.splitCues.every(c => c.arc_parent_cue_id === 'mother' && c.arc_id === 'family'));
  assert.deepEqual(compiled.splitCues.map(c => c.required_action_ids), [[], [], ['reply']]);
  assert.ok(compiled.splitCues.every(c => c.query.min_duration === 10));
  assert.deepEqual(compiled.arcManifest.arcs[0].original_cue, input.director.cues[0]);
  assert.equal(compiled.pending.length, 2);
  assert.equal(compiled.artistic_acceptance, 'not_assessed');
  assert.equal(compiled.production_approval, false);
  compiled.splitCues[0].query.function = 'changed';
  assert.deepEqual(input, before);
});

test('every original mother must appear exactly once without silent omission', () => {
  for (const mutate of [
    input => { input.director.cues.push({ ...input.director.cues[0], cue_id: 'missing' }); },
    input => { input.plan.arcs[0].cue_id = 'unknown'; },
    input => { input.plan.arcs.push(structuredClone(input.plan.arcs[0])); },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => compileSoundArcPlan(input), /exact_mother_cue_coverage_required/);
  }
});

test('adjacent parent arcs have a bound seam even when each contains just one piece', () => {
  const input = fixture(), original = structuredClone(input.director.cues[0]);
  input.director.cues = ['first', 'second'].map((cue_id, index) => ({ ...original, cue_id,
    target_range: [index * 10, (index + 1) * 10], required_action_ids: [] }));
  input.director.music_actions = [];
  input.candidates = input.director.cues.map(cue => ({ ...input.candidates[0], cue_id: cue.cue_id }));
  input.plan.arcs = input.director.cues.map((cue, index) => ({ arc_id: cue.cue_id, cue_id: cue.cue_id,
    pieces: [{ ...structuredClone(input.plan.arcs[0].pieces[0]), piece_id: 'whole',
      target_range: cue.target_range, source_window: { ...input.plan.arcs[0].pieces[0].source_window,
        source_range: [10 + index * 10, 20 + index * 10] } }] }));
  const before = structuredClone(input), compiled = compileSoundArcPlan(input);
  assert.deepEqual(input, before);
  assert.equal(compiled.seams.length, 1, 'cross-parent music cuts must not vanish from seam review');
  assert.equal(compiled.seams[0].seam_type, 'between_arcs');
  assert.equal(compiled.seams[0].target_seconds, 10);
  assert.deepEqual(compiled.seams[0].from_source_window.source_range, [10, 20]);
  assert.deepEqual(compiled.seams[0].to_source_window.source_range, [20, 30]);
  assert.equal(compiled.pending.length, 1);
  assert.equal(compiled.production_approval, false);
});

test('a gap, overlap, outside target, or missing ending cannot erase mother coverage', () => {
  for (const [mutate, reason] of [
    [input => { input.plan.arcs[0].pieces[1].target_range[0] = 11; }, /coverage_gap_or_overlap/],
    [input => { input.plan.arcs[0].pieces[1].target_range[0] = 9; }, /coverage_gap_or_overlap/],
    [input => { input.plan.arcs[0].pieces[2].target_range[1] = 31; }, /target_outside_mother/],
    [input => { input.plan.arcs[0].pieces.pop(); }, /coverage_incomplete/],
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => compileSoundArcPlan(input), reason);
  }
});

test('even one missing or overlapping 48k sample cannot disappear at a piece boundary or mother ending', () => {
  for (const delta of [-1 / 48000, 1 / 48000]) {
    const input = fixture(); input.plan.arcs[0].pieces[1].target_range[0] += delta;
    assert.throws(() => compileSoundArcPlan(input), /coverage_gap_or_overlap/);
  }
  const input = fixture(), last = input.plan.arcs[0].pieces[2];
  last.target_range[1] -= 1 / 48000; last.source_window.source_range[1] -= 1 / 48000;
  assert.throws(() => compileSoundArcPlan(input), /coverage_incomplete/);
});

test('old video, recording identity, candidate range, and invented source bounds are rejected', () => {
  for (const [mutate, reason] of [
    [input => { input.plan.source_video_sha256 = 'c'.repeat(64); }, /current_video_binding/],
    [input => { input.plan.arcs[0].pieces[0].source_window.source_sha256 = 'c'.repeat(64); }, /stale_or_unknown_candidate/],
    [input => { input.plan.arcs[0].pieces[0].source_window.asset_id = 'invented'; }, /stale_or_unknown_candidate/],
    [input => { input.plan.arcs[0].pieces[0].source_window.candidate_source_range = [0, 90]; }, /stale_or_unknown_candidate/],
    [input => { input.plan.arcs[0].pieces[0].source_window.source_range = [95, 105]; }, /frozen_source_window/],
    [input => { input.candidates[0].library_allowed_source_range = [40, 100]; }, /source_outside_current_candidate/],
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => compileSoundArcPlan(input), reason);
  }
});

test('candidate source identity compares exact 48k boundaries, not floating point spellings', () => {
  const input = fixture();
  input.candidates[0].source_range = [0, 101.15100000000001];
  input.plan.arcs[0].pieces.forEach(piece => { piece.source_window.candidate_source_range = [0, 101.151]; });
  assert.equal(compileSoundArcPlan(input).splitCues.length, 3);
  input.plan.arcs[0].pieces[0].source_window.candidate_source_range[1] += 1 / 48000;
  assert.throws(() => compileSoundArcPlan(input), /stale_or_unknown_candidate_source/);
  input.plan.arcs[0].pieces[0].source_window.candidate_source_range[1] -= 1 / 48000;
  input.plan.arcs[0].pieces[0].source_window.source_sha256 = 'c'.repeat(64);
  assert.throws(() => compileSoundArcPlan(input), /stale_or_unknown_candidate_source/);
});

test('a broad indexed segment cannot expand a case window or an actually observed window', () => {
  const input = fixture();
  input.candidates[0].case_source_range = [0, 85];
  input.plan.arcs[0].pieces.forEach(p => { p.source_window.candidate_source_range = [0, 85]; });
  assert.equal(compileSoundArcPlan(input).splitCues.length, 3);
  input.candidates[0].source_range = [0, 70];
  assert.throws(() => compileSoundArcPlan(input), /source_outside_current_candidate_window/);
});

test('a selected crisis source cannot be moved into a different target part of the same mother arc', () => {
  const input = fixture(); input.candidates[0].allowed_target_range = [10, 30];
  assert.throws(() => compileSoundArcPlan(input), /piece_target_outside_actual_candidate_task/);
  input.candidates.push({ ...input.candidates[0], allowed_target_range: [0, 10] });
  assert.equal(compileSoundArcPlan(input).splitCues.length, 3);
});

test('a short source cannot become a whole music development through implicit looping', () => {
  const input = fixture(); input.plan.arcs[0].pieces[0].source_window.source_range = [10, 12];
  assert.throws(() => compileSoundArcPlan(input), /source_window_too_short_no_implicit_loop/);
});

test('a longer window cannot be trimmed while claiming its unused end forms the seam', () => {
  const input = fixture(); input.plan.arcs[0].pieces[0].source_window.source_range = [10, 25];
  assert.throws(() => compileSoundArcPlan(input), /source_and_target_sample_lengths_must_match/);
});

test('connections name the actual previous piece rather than just supplying a generic fade', () => {
  for (const mutate of [
    input => { input.plan.arcs[0].pieces[1].connection_from.previous_piece_id = 'release'; },
    input => { input.plan.arcs[0].pieces[1].connection_from.reason = ' '; },
    input => { input.plan.arcs[0].pieces[0].connection_from = { previous_piece_id: 'invented', reason: 'fade' }; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => compileSoundArcPlan(input), /explicit_previous_piece_connection/);
  }
});

test('the only piece containing the complete Chinese words target inherits its required subtask', () => {
  const input = fixture(); Object.assign(input.director.cues[0], { words_candidate_request: 'require',
    words_target_range: [22, 26], words_mode: 'song_replace', words_function: 'family-reply',
    words_audio_retrieval_query: 'A complete reply phrase', vocal_language: 'zh', words_complete_phrase_required: true });
  input.candidates[0].words_evidence = { content_status: 'verified', complete_phrase: true,
    actual_words: '未经验证的样本字', vocal_language: 'zh', actual_audio_processed: true };
  const result = compileSoundArcPlan(input);
  assert.ok(result.splitCues.slice(0, 2).every(c => !('words_candidate_request' in c) && !('words_target_range' in c)
    && !('words_complete_phrase_required' in c)));
  assert.deepEqual(result.splitCues[2].words_target_range, [22, 26]);
  assert.equal(result.splitCues[2].words_candidate_request, 'require');
  assert.equal(result.splitCues[2].words_complete_phrase_required, true);
  assert.equal(result.splitCues[2].vocal_language, 'zh');
  assert.ok(result.splitCues.every(c => !('words_evidence' in c) && !('listening_evidence' in c)));
  assert.ok(result.splitCues.every(c => !('words_evidence' in c.requested_candidates[0])));
  assert.equal(result.production_approval, false);
});

test('words crossing pieces or an unbounded require request cannot be silently lost', () => {
  const input = fixture(); Object.assign(input.director.cues[0], { words_candidate_request: 'require', words_target_range: [8, 12] });
  assert.throws(() => compileSoundArcPlan(input), /whole_words_window_requires_one_piece/);
  delete input.director.cues[0].words_target_range;
  assert.throws(() => compileSoundArcPlan(input), /words_request_requires_explicit_target_window/);
});

test('strict director schema cannot smuggle listening or Chinese qualification claims', () => {
  const input = fixture();
  validateSchema(input.plan, soundArcPlanSchema);
  input.plan.arcs[0].pieces[0].qualified = true;
  assert.throws(() => compileSoundArcPlan(input), /extra_field/);
});

// These synthetic receipts exercise the evidence contract. They do not qualify music hearing.
function seamEvidence(seam, mutateRecord = () => {}, mutateReceipt = () => {}, mutateQualification = () => {}, mutateResponse = () => {}) {
  const dir = join(work, String(++ordinal)); mkdirSync(dir);
  const put = (name, data) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    const file = join(dir, name); writeFileSync(file, bytes);
    return { path: file, sha256: createHash('sha256').update(bytes).digest('hex') };
  };
  const input = put('input.wav', Buffer.from('synthetic input contract fixture'));
  const backend = { protocol: 'gemini_interactions', backend_id: 'synthetic-listener', model_revision: 'gemini-contract-fixture' };
  const receipt = { audio_sha256: input.sha256, source_sha256: 'c'.repeat(64), source_window: [5, 15],
    ...backend, request_id: 'synthetic-request', model: backend.model_revision, finish_reason: 'complete' };
  const record = { actual_audio_processed: true, completion_status: 'complete', finish_reason: 'complete',
    purpose: 'mix', source_video_sha256: videoSha, source_sha256: 'c'.repeat(64), source_range: [5, 15],
    ...backend, request_id: 'synthetic-request', model: backend.model_revision, input_audio: input,
    synchronized_video: { ...put('synchronized.mp4', Buffer.from('synthetic synchronized video contract fixture')),
      source_video_sha256: videoSha, source_audio_sha256: 'c'.repeat(64), source_range: [5, 15] },
    execution: { ...backend, model: backend.model_revision, actual_audio_processed: true, audio_sha256: input.sha256, request_id: 'synthetic-request' },
    observation: { description: 'Synthetic observation contract only', issues: [], uncertainties: [] } };
  mutateRecord(record);
  const response = { id: 'synthetic-request', status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(record.observation) }] }] };
  mutateResponse(response); receipt.raw_response = put('response.json', response);
  mutateReceipt(receipt); record.api_evidence = put('receipt.json', receipt);
  const qualification = { status: 'qualified', ...backend, scopes: ['audio_observation', 'music_candidate_judgment'] };
  mutateQualification(qualification);
  return { seam_id: seam.seam_id, pair_binding_sha256: seam.pair_binding_sha256,
    observation_record: put('observation.json', record), qualification_record: put('qualification.json', qualification) };
}

test('actual paired seams stay pending until complete bound receipts cover both sides', () => {
  const { arcManifest, seams } = compileSoundArcPlan(fixture());
  const evidence = seamEvidence(seams[0]);
  const result = validateSoundArcSeams({ arcManifest, seamObservations: [evidence] });
  assert.equal(result.seamObservations[0].status, 'verified_records_only');
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].seam_id, seams[1].seam_id);
  assert.equal(result.artistic_acceptance, 'not_assessed');
  assert.equal(result.production_approval, false);
});

test('source-processed flags alone, wrong pairs, and duplicated evidence cannot approve a seam', () => {
  const { arcManifest, seams } = compileSoundArcPlan(fixture());
  const flag = { seam_id: seams[0].seam_id, pair_binding_sha256: seams[0].pair_binding_sha256, actual_audio_processed: true };
  assert.equal(validateSoundArcSeams({ arcManifest, seamObservations: [flag] }).pending.length, 2);
  const evidence = seamEvidence(seams[0]); evidence.pair_binding_sha256 = 'f'.repeat(64);
  assert.match(validateSoundArcSeams({ arcManifest, seamObservations: [evidence] }).pending[0].reason, /stale_seam_pair_binding/);
  assert.throws(() => validateSoundArcSeams({ arcManifest, seamObservations: [evidence, evidence] }), /duplicate_seam_observation/);
});

test('truncation, stale video, one-sided hearing, uncertainty, and bad submission bindings remain pending', () => {
  const { arcManifest, seams } = compileSoundArcPlan(fixture());
  for (const [recordMutation, receiptMutation, qualificationMutation, reason] of [
    [r => { r.completion_status = 'truncated'; }, () => {}, () => {}, /complete_actual_mix/],
    [r => { r.source_video_sha256 = 'f'.repeat(64); }, () => {}, () => {}, /current_mix_window/],
    [r => { r.source_range = [10, 15]; }, () => {}, () => {}, /cover_both_seam_sides/],
    [r => { r.observation.uncertainties = ['Need actual hearing']; }, () => {}, () => {}, /resolved_actual_seam/],
    [r => { r.observation.issues = [{ start_seconds: 4, end_seconds: 6, kind: 'transition' }]; }, () => {}, () => {}, /seam_needs_revision/],
    [() => {}, r => { r.audio_sha256 = 'f'.repeat(64); }, () => {}, /actual_submission_receipt/],
    [() => {}, () => {}, q => { q.scopes = ['synthetic_audio_integrity']; }, /qualified_mix_listener/],
    [() => {}, () => {}, q => { q.model_revision = 'gemini-old-fixture'; }, /qualified_mix_listener/],
    [() => {}, r => { r.model_revision = 'gemini-old-fixture'; }, () => {}, /actual_submission_receipt/],
  ]) {
    const evidence = seamEvidence(seams[0], recordMutation, receiptMutation, qualificationMutation);
    const result = validateSoundArcSeams({ arcManifest, seamObservations: [evidence] });
    assert.equal(result.pending.length, 2); assert.match(result.pending[0].reason, reason);
  }
});

test('changed observation bytes invalidate a formerly bound seam record', () => {
  const { arcManifest, seams } = compileSoundArcPlan(fixture());
  const evidence = seamEvidence(seams[0]); writeFileSync(evidence.observation_record.path, '{}');
  assert.match(validateSoundArcSeams({ arcManifest, seamObservations: [evidence] }).pending[0].reason, /evidence_file_hash_mismatch/);
});

test('a completed request cannot replace its actual raw observation or synchronized video binding', () => {
  const { arcManifest, seams } = compileSoundArcPlan(fixture());
  for (const [mutateRecord, mutateResponse, reason] of [
    [record => { delete record.synchronized_video; }, () => {}, /evidence_file_binding_required/],
    [record => { record.synchronized_video.source_audio_sha256 = 'f'.repeat(64); }, () => {}, /synchronized_mix_binding_required/],
    [record => { record.synchronized_video.source_video_sha256 = 'f'.repeat(64); }, () => {}, /synchronized_mix_binding_required/],
    [record => { record.synchronized_video.source_range = [4, 15]; }, () => {}, /synchronized_mix_binding_required/],
    [() => {}, response => { response.steps[0].status = 'incomplete'; }, /submission_receipt_binding_required/],
    [() => {}, response => { delete response.steps; }, /mix_response_output_required/],
    [() => {}, response => { response.steps[0].content[0].text = JSON.stringify({ description: 'An unrelated observation' }); }, /response_observation_mismatch/],
  ]) {
    const evidence = seamEvidence(seams[0], mutateRecord, () => {}, () => {}, mutateResponse);
    const result = validateSoundArcSeams({ arcManifest, seamObservations: [evidence] });
    assert.equal(result.pending.length, 2); assert.match(result.pending[0].reason, reason);
  }
});
