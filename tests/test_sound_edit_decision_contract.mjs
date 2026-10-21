import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { readJson, saveJson, validateSchema } from '../scripts/audio_api.mjs';
import { canonicalizeBoundPhysicalSoundRetains, applyStrictSoundEditDecisionSchema, strictSoundEditDecisionRevision } from '../scripts/sound_edit_decision_contract.mjs';
import { researchAssemblySchema } from '../scripts/assemble_research_episode.mjs';
import { createBoundSoundDecisionRecovery, loadBoundSoundDecisionRecovery, verifyBoundSoundDecisionRecoveryForRender,
  preflightBoundSoundDecisionControllerRecovery } from '../scripts/bound_sound_decision_recovery.mjs';
import { loadBoundAssemblyRecovery } from '../scripts/research_assembly_resume.mjs';
import { hashFile } from '../scripts/render_binding.mjs';

function fixture() {
  const event = { id: 'physical-1', role: 'physical', decision: 'retain_original', start_seconds: 0, end_seconds: 5,
    evidence_ids: ['visual-only-no-heard-sound'] };
  const guidance = { event_id: event.id, role: event.role, decision: 'omit', original_status: 'unknown',
    preserve_original_track: true, selected_segment_id: null, selected_source_range: null, source_anchor_seconds: null };
  const original = { plan: { music: 'unaltered actual music source-clock plan' }, edits: {
    music_edits: [{ source_range: [5, 10], gain_envelope: [{ offset_seconds: 0, gain_db: -6 }] }],
    sounds: [{ event_id: event.id, decision: 'retain_original', selected_segment_id: null, source_range: null,
      original_status: 'unknown', target_seconds: 0, source_anchor_seconds: 0, gain_db: 0, fade_in_seconds: 0,
      fade_out_seconds: 0, reason: 'Unknown physical sound: preserve original track.', anchor_evidence: 'visual-only-no-heard-sound' }] },
    execution_gaps: [], review_pending: ['Actual sound and artistic judgment remain unqualified.'] };
  return { input: { data: { analysis: { sound_events: [event] }, sound_event_guidance: [guidance] } }, original };
}
test('physical original-track policy compiles to no-added-sound and preserves every other value', () => {
  const row = fixture(), before = structuredClone(row), result = canonicalizeBoundPhysicalSoundRetains(row.input, row.original);
  assert.deepEqual(row, before); assert.equal(result.changes.length, 1);
  assert.equal(result.changes[0].pointer, '/edits/sounds/0/decision');
  const restored = structuredClone(result.value); restored.edits.sounds[0].decision = 'retain_original';
  assert.deepEqual(restored, row.original); assert.equal(result.value.edits.sounds[0].decision, 'omit');
  assert.equal(result.value.edits.sounds[0].original_status, 'unknown');
});
test('nonphysical, actual additions, guessed original facts and unbound edits cannot be repaired', () => {
  for (const change of [
    row => row.input.data.analysis.sound_events[0].role = 'dramatic',
    row => row.input.data.analysis.sound_events[0].decision = 'seek_asset',
    row => row.input.data.sound_event_guidance[0].decision = 'pending_assembly_adoption',
    row => row.input.data.sound_event_guidance[0].preserve_original_track = false,
    row => row.input.data.sound_event_guidance[0].selected_source_range = [0, 1],
    row => row.original.edits.sounds[0].selected_segment_id = 'actual-asset',
    row => row.original.edits.sounds[0].source_range = [0, 1],
    row => row.original.edits.sounds[0].asset_id = 'actual-asset',
    row => row.original.edits.sounds[0].original_status = 'verified_present',
    row => row.original.edits.sounds[0].gain_db = 1,
    row => row.original.edits.sounds[0].fade_in_seconds = 0.1,
    row => row.original.edits.sounds[0].source_anchor_seconds = 0.1,
    row => row.original.edits.sounds[0].target_seconds = 8,
    row => row.original.execution_gaps.push('A real execution problem cannot be erased.'),
    row => row.original.edits.sounds[0].event_id = 'foreign',
    row => row.original.edits.sounds.push(structuredClone(row.original.edits.sounds[0])),
  ]) { const row = fixture(); change(row); assert.throws(() => canonicalizeBoundPhysicalSoundRetains(row.input, row.original)); }
});
test('existing new_asset and omit choices are retained, not invented or substituted', () => {
  const row = fixture();
  row.input.data.analysis.sound_events.push({ id: 'accent', role: 'dramatic', decision: 'seek_asset', start_seconds: 5, end_seconds: 8 });
  row.input.data.sound_event_guidance.push({ event_id: 'accent', decision: 'pending_assembly_adoption' });
  row.original.edits.sounds.push({ event_id: 'accent', decision: 'new_asset', selected_segment_id: 'actually-selected', source_range: [0, 1], gain_db: -6 });
  assert.deepEqual(canonicalizeBoundPhysicalSoundRetains(row.input, row.original).value.edits.sounds[1], row.original.edits.sounds[1]);
});
test('explicit new contract narrows future schema without changing any legacy schema bytes or aliases', () => {
  const old = researchAssemblySchema({ assembly_contract_version: 2, music_action_contract_version: 2 }), before = JSON.stringify(old);
  const next = researchAssemblySchema({ assembly_contract_version: 2, music_action_contract_version: 2,
    sound_edit_decision_contract_revision: strictSoundEditDecisionRevision });
  assert.equal(JSON.stringify(old), before);
  assert.equal(applyStrictSoundEditDecisionSchema(old, undefined), old);
  assert.deepEqual(next.properties.edits.properties.sounds.items.properties.decision.enum, ['new_asset', 'omit']);
  assert.ok(old.properties.edits.properties.sounds.items.properties.decision.enum.includes('retain_original'));
  assert.throws(() => validateSchema('retain_original', next.properties.edits.properties.sounds.items.properties.decision));
  validateSchema('omit', next.properties.edits.properties.sounds.items.properties.decision);
  assert.throws(() => applyStrictSoundEditDecisionSchema(old, 'unknown-version'));
});

const real = process.env.SDR_SOUND_DECISION_REAL_FIXTURE;
test('actual two completed CLI parts recover only the physical no-op; strict loader and render reverify all bindings', { skip: !real }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'sdr-sound-decision-'));
  const ref = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
  try {
    const caller = await ref(path.join(real, 'assembly-input.json')),
      preflight = await ref(path.join(real, 'bounded-assembly/preflight.json')),
      parts = await Promise.all([1, 2].map(i => ref(path.join(real, `bounded-assembly/part-${i}/completed.json`))));
    const binding = await createBoundSoundDecisionRecovery({ caller, preflight, parts, outputDir: out });
    const input = await readJson(caller.path), options = { inputs: input.data.bound_artifacts,
      schema: input.schema, source: { sha256: input.data.source_video_sha256 } };
    const recovered = await loadBoundAssemblyRecovery(binding, options);
    assert.equal(recovered.new_model_calls, 0); assert.equal(recovered.cli_receipts.length, 0);
    assert.equal(recovered.historical_cli_receipts.length, 2);
    assert.equal(recovered.value.edits.sounds.filter(row => row.decision === 'new_asset').length, 3);
    assert.equal(recovered.value.edits.sounds.filter(row => row.decision === 'omit').length, 2);
    const verified = await verifyBoundSoundDecisionRecoveryForRender({ config: { ...options.inputs,
      assembly_sound_decision_recovery: binding }, sourceSha: options.source.sha256, edits: recovered.value.edits, rawResponse: recovered.raw_response });
    assert.equal(verified.new_model_calls, 0);
    if (process.env.SDR_SOUND_DECISION_CONTROLLER_STATE_FIXTURE) {
      const state = await readJson(process.env.SDR_SOUND_DECISION_CONTROLLER_STATE_FIXTURE);
      const config = await readJson(path.resolve(real, '../../../../../..', 'deployment.json'));
      const scope = { config, source: state.source, state };
      const controller = await preflightBoundSoundDecisionControllerRecovery(binding, scope);
      assert.equal(controller.completed_material_execution_reused, true);
      assert.deepEqual(controller.materials_result, state.stages.materials.result_binding);
      // A new restrictive schema cannot change the original recovery contract.
      const changedSchemaConfig = { ...config, sound_edit_decision_contract_revision: strictSoundEditDecisionRevision };
      assert.equal((await preflightBoundSoundDecisionControllerRecovery(binding, { ...scope, config: changedSchemaConfig })).proof.new_model_calls, 0);
      for (const change of [
        row => row.config.mode = 'production',
        row => row.config.trial_review_policy = 'formal_review',
        row => row.config.source_policy.kind = 'reference_original_only',
        row => row.state.stages.materials.status = 'waiting',
        row => row.state.stages.materials.result.selected_count = 999,
        row => row.state.stages.assembly.status = 'completed',
        row => row.state.stages.assembly.error = 'different_failure',
        row => row.state.stages.assembly.directory = path.resolve(real, 'foreign-attempt'),
      ]) { const bad = structuredClone(scope); change(bad); await assert.rejects(() => preflightBoundSoundDecisionControllerRecovery(binding, bad)); }
    }
    if(process.env.SDR_SOUND_DECISION_ADOPTION_CONTINUATION_FIXTURE){
      const state=await readJson(process.env.SDR_SOUND_DECISION_ADOPTION_CONTINUATION_FIXTURE),
        config=await readJson(path.resolve(real,'../../../../../..','deployment.json')),
        scope={config,source:state.source,state},continuedBinding=state.bound_assembly_material_reuse[0].recovery,
        continued=await preflightBoundSoundDecisionControllerRecovery(continuedBinding,scope);
      assert.equal(continued.adoption_continuation.revision,'bound-retrieval-direction-adoption-continuation-v1');
      assert.equal(continued.adoption_continuation.direction_chains.length,3);
      assert.equal(continued.adoption_continuation.new_model_calls,0);
      assert.deepEqual(continued.materials_result,state.stages.materials.result_binding);
      for(const change of [
        row=>row.state.stages.assembly.error='some_other_sfx_failure',
        row=>row.state.stages.assembly.attempt=3,
        row=>row.state.stage_attempt_history=[],
        row=>row.state.bound_assembly_material_reuse[0].recovery.sha256='f'.repeat(64),
        row=>row.state.bound_assembly_material_reuse[0].materials_result.sha256='f'.repeat(64),
        row=>row.state.stages.assembly.cli_receipts=[{}],
      ]){const bad=structuredClone(scope);change(bad);await assert.rejects(()=>preflightBoundSoundDecisionControllerRecovery(continuedBinding,bad));}
    }
    await assert.rejects(() => loadBoundSoundDecisionRecovery(binding, { ...options, source: { sha256: 'f'.repeat(64) } }));
    await assert.rejects(() => loadBoundSoundDecisionRecovery(binding, { ...options,
      inputs: { ...options.inputs, director: { ...options.inputs.director, sha256: 'f'.repeat(64) } } }));
    const badEdits = structuredClone(recovered.value.edits); badEdits.music_edits[0].gain_db += 1;
    await assert.rejects(() => verifyBoundSoundDecisionRecoveryForRender({ config: { ...options.inputs,
      assembly_sound_decision_recovery: binding }, sourceSha: options.source.sha256, edits: badEdits }));
    await assert.rejects(() => verifyBoundSoundDecisionRecoveryForRender({ config: {}, sourceSha: options.source.sha256,
      edits: recovered.value.edits, rawResponse: recovered.raw_response }));
    const record = await readJson(binding.path), adapter = await readJson(record.adapter.path);
    adapter.changes[0].to = 'new_asset'; const badAdapter = await saveJson(path.join(out, 'bad-adapter.json'), adapter);
    const badBinding = await saveJson(path.join(out, 'bad-recovery.json'), { ...record, adapter: badAdapter });
    await assert.rejects(() => loadBoundSoundDecisionRecovery(badBinding, options));
  } finally { await rm(out, { recursive: true, force: true }); }
});
