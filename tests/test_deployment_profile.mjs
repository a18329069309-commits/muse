import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access,mkdir,mkdtemp,readdir,rm} from 'node:fs/promises';
import {readJson,saveJson} from '../scripts/audio_api.mjs';
import {createIndependentTrialDeployment} from '../scripts/create_independent_trial_deployment.mjs';
import {loadUploadDeploymentProfile} from '../scripts/compose_uploaded_episode.mjs';
import {hashFile} from '../scripts/render_binding.mjs';

const artifacts=fileURLToPath(new URL('../.muse/',import.meta.url));
async function fixture(t,runtime={}){
  await mkdir(artifacts,{recursive:true});
  const root=await mkdtemp(path.join(artifacts,'deployment-contract-'));
  t.after(async()=>{
    assert.equal(path.dirname(root),path.resolve(artifacts));
    assert.ok(path.basename(root).startsWith('deployment-contract-'));
    await rm(root,{recursive:true,force:true});
  });
  const library=await saveJson(path.join(root,'synthetic-library.json'),{synthetic_contract_fixture:true});
  const music_packs=await saveJson(path.join(root,'synthetic-publication.json'),{
    kind:'independent_music_pack_publication',library,synthetic_contract_fixture:true,
  });
  if(typeof runtime==='function')runtime=await runtime(root);
  const profile=await saveJson(path.join(root,'runtime.json'),runtime);
  return {root,directory:path.join(root,'new-deployment'),music_packs,runtime_profile:profile.path,
    authorization_evidence:'Synthetic offline deployment contract test; not actual music or listening approval'};
}

const backend={protocol:'gemini_interactions',backend_id:'gemini-3.8-flash',model_revision:'gemini-3.8-flash'};
async function syntheticQualification(root,overrides={}){
  // These files exercise a legacy validator's data contract, not actual calibration.
  // The enclosing fixture is deleted after every test; nothing can be published or reused.
  const evidence=await saveJson(path.join(root,'not-real-listening-evidence.json'),{
    synthetic_contract_fixture:true,not_real_listening_qualification:true,
  });
  const fixture_manifest=await saveJson(path.join(root,'not-real-listening-manifest.json'),{
    synthetic_contract_fixture:true,not_real_listening_qualification:true,
  });
  return saveJson(path.join(root,'not-real-listening-qualification.json'),{
    schema_version:2,status:'qualified',...backend,synthetic_contract_fixture:true,
    not_real_listening_qualification:true,scopes:['audio_observation','music_candidate_judgment'],
    evidence,fixture_manifest,truth_coverage:{real_audio_sufficient:true,scene_truth_sufficient:true},
    fixture_results:Array.from({length:16},()=>({truth_group:'real_audio',status:'scored',reasons:[]})),
    scene_pair_results:['scene-a','scene-b','scene-c'].map(scene_kind=>({scene_kind,status:'scored',reasons:[]})),
    results:[{...backend,actual_audio_processed:true,audit_binding_verified:true,
      completion_status:'complete',api_evidence:evidence}],...overrides,
  });
}

test('new independent deployments refuse even an empty existing output directory',async t=>{
  const input=await fixture(t);
  await mkdir(input.directory);
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_new_directory_required/);
  assert.deepEqual(await readdir(input.directory),[]);
});

test('new strict deployments preserve bound listener settings through the real upload loader',async t=>{
  const input=await fixture(t,async root=>({quality_review_policy:'automatic_required',
    quality_review_audio_backend:backend,quality_review_qualification:await syntheticQualification(root)}));
  const source=await readJson(input.runtime_profile);
  const output=await createIndependentTrialDeployment(input);
  const loaded=await loadUploadDeploymentProfile(output.deployment.path);
  assert.equal(loaded.schema_version,1);
  assert.equal(loaded.quality_review_policy,'automatic_required');
  assert.deepEqual(loaded.quality_review_audio_backend,backend);
  assert.deepEqual(loaded.quality_review_qualification,source.quality_review_qualification);
  const authorization=await readJson(output.authorization.path);
  assert.equal(authorization.production_approval,false);
  assert.equal(authorization.material_or_listening_approval,false);
  assert.equal((await readJson(output.consumer_publication.path)).artistic_acceptance,'pending_actual_audition');
});

test('strict deployments without a listener identity fail before creating authorization or output',async t=>{
  const input=await fixture(t,{quality_review_policy:'automatic_required'});
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_audio_review_backend_required/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('strict deployments without a bound qualification fail without partial authorization',async t=>{
  const input=await fixture(t,{quality_review_policy:'automatic_required',quality_review_audio_backend:backend});
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_audio_review_qualification_required/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('strict deployments reject a changed qualification hash before output creation',async t=>{
  const input=await fixture(t,async root=>({quality_review_policy:'automatic_required',
    quality_review_audio_backend:backend,
    quality_review_qualification:{...await syntheticQualification(root),sha256:'0'.repeat(64)}}));
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_audio_review_qualification_invalid/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('strict deployments refuse legacy schema1 qualification rather than claiming scene readiness',async t=>{
  const input=await fixture(t,async root=>({quality_review_policy:'automatic_required',
    quality_review_audio_backend:backend,quality_review_qualification:await syntheticQualification(root,{schema_version:1})}));
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_schema2_audio_review_qualification_required/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('invalid offline material settings cannot leave a partial authorization behind',async t=>{
  const input=await fixture(t,{material_readiness_policy:'offline_ready_only',material_observer_kind:'frozen_offline'});
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_offline_ready_publication_required/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('unknown quality policies fail locally instead of producing an upload-invalid deployment',async t=>{
  const input=await fixture(t,{quality_review_policy:'automatically-approved'});
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_quality_review_policy_invalid/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('schema1 diagnostic defaults and explicit diagnostic policy remain compatible without listener creation',async t=>{
  for(const policy of [undefined,'diagnostic_only']){
    const input=await fixture(t,policy?{quality_review_policy:policy}:{});
    const output=await createIndependentTrialDeployment(input);
    const loaded=await loadUploadDeploymentProfile(output.deployment.path);
    assert.equal(loaded.schema_version,1);
    assert.equal(loaded.quality_review_policy,policy);
    assert.equal(Object.hasOwn(loaded,'quality_review_audio_backend'),false);
    assert.equal(Object.hasOwn(loaded,'quality_review_qualification'),false);
    assert.deepEqual((await readdir(input.directory)).sort(),[
      'authorization.json','consumer-publication.json','deployment.json']);
  }
});

test('diagnostic profiles can preserve existing legacy listener bindings without promoting them to strict mode',async t=>{
  const input=await fixture(t,async root=>({quality_review_policy:'diagnostic_only',
    quality_review_audio_backend:backend,quality_review_qualification:await syntheticQualification(root,{schema_version:1})}));
  const source=await readJson(input.runtime_profile),output=await createIndependentTrialDeployment(input);
  const loaded=await loadUploadDeploymentProfile(output.deployment.path);
  assert.equal(loaded.quality_review_policy,'diagnostic_only');
  assert.deepEqual(loaded.quality_review_qualification,source.quality_review_qualification);
});

test('an optional diagnostic qualification must also carry an explicit immutable file binding',async t=>{
  const input=await fixture(t,async root=>({quality_review_policy:'diagnostic_only',
    quality_review_audio_backend:backend,quality_review_qualification:(await syntheticQualification(root,{schema_version:1})).path}));
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_audio_review_qualification_required/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

for(const [name,change,reason] of [
  ['unsupported listener protocol',async()=>({quality_review_audio_backend:{...backend,protocol:'invented'}}),/unsupported_audio_backend_protocol/],
  ['listener identity mismatch',async()=>({quality_review_audio_backend:{...backend,backend_id:'other-audio-backend'}}),/qualification_invalid/],
  ['missing bound qualification file',async root=>({quality_review_qualification:{path:path.join(root,'missing.json'),sha256:'0'.repeat(64)}}),/qualification_invalid/],
  ['missing qualification digest',async root=>({quality_review_qualification:{path:path.join(root,'not-real-listening-qualification.json')}}),/qualification_required/],
  ['insufficient qualification scopes',async root=>({quality_review_qualification:await syntheticQualification(root,{scopes:['audio_observation']})}),/qualification_invalid/],
  ['insufficient audio calibration facts',async root=>({quality_review_qualification:await syntheticQualification(root,{fixture_results:[]})}),/qualification_invalid/],
  ['fractional qualification schema version',async root=>({quality_review_qualification:await syntheticQualification(root,{schema_version:2.5})}),/schema2_audio_review_qualification_required/],
])test(`strict deployments reject ${name} without creating output`,async t=>{
  const input=await fixture(t,async root=>{
    // Generate at most one ephemeral qualification artifact per case.
    const changed=await change(root);
    return {quality_review_policy:'automatic_required',quality_review_audio_backend:backend,
      ...(Object.hasOwn(changed,'quality_review_qualification')?{}:{quality_review_qualification:await syntheticQualification(root)}),
      ...changed};
  });
  await assert.rejects(createIndependentTrialDeployment(input),reason);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('qualification evidence bindings are verified rather than trusting a qualified label',async t=>{
  const input=await fixture(t,async root=>{
    const tampered=await saveJson(path.join(root,'tampered-evidence.json'),{synthetic_contract_fixture:true});
    return {quality_review_policy:'automatic_required',quality_review_audio_backend:backend,
      quality_review_qualification:await syntheticQualification(root,{evidence:{...tampered,sha256:'0'.repeat(64)}})};
  });
  await assert.rejects(createIndependentTrialDeployment(input),/qualification_invalid/);
  await assert.rejects(access(input.directory),{code:'ENOENT'});
});

test('an existing deployment and pending episode ledger cannot be overwritten or reset',async t=>{
  const input=await fixture(t),output=await createIndependentTrialDeployment(input);
  const ledger=await saveJson(path.join(input.directory,'existing-episode-ledger.json'),{
    synthetic_contract_fixture:true,pending:[{request_id:'synthetic-pending-must-stay'}],requests:4,
  });
  const bindings=[output.deployment,output.authorization,output.consumer_publication,ledger];
  await assert.rejects(createIndependentTrialDeployment(input),/independent_deployment_new_directory_required/);
  for(const binding of bindings)assert.equal(await hashFile(binding.path),binding.sha256);
});

test('concurrent new deployment attempts allow one exclusive creator and leave its upload profile intact',async t=>{
  const input=await fixture(t);
  const attempts=await Promise.allSettled([createIndependentTrialDeployment(input),createIndependentTrialDeployment(input)]);
  assert.equal(attempts.filter(row=>row.status==='fulfilled').length,1);
  const failure=attempts.find(row=>row.status==='rejected');
  assert.match(failure.reason.message,/independent_deployment_new_directory_required/);
  const output=attempts.find(row=>row.status==='fulfilled').value;
  assert.equal((await loadUploadDeploymentProfile(output.deployment.path)).schema_version,1);
});
