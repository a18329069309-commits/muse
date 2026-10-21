import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {saveJson} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {resolveDiagnosticEnvelopeCalibrations as resolve} from './diagnostic_cli_calibration_resolution.mjs';

async function fixture(){
  const root=await mkdtemp(path.join(os.tmpdir(),'sdr-cli-calibration-'));
  const old=path.join(root,'old','codex.exe'),current=path.join(root,'codex.exe');
  await writeFile(current,'isolated test executable identity, never executed');
  const resolution={requested_path:old,actual_path:current,version:'codex-cli 0.200.0',fallback_used:true,
    resolution_kind:'missing_configured_path_to_verified_codex_application_bin',actual_executable_sha256:await hashFile(current)};
  const make=async (name,kind)=>saveJson(path.join(root,name+'.json'),{schema_version:1,kind,
    profile:{cli:{actual_path:old,current_executable_sha256:'a'.repeat(64)}},
    professional_qualification_granted:false,production_approval:false});
  return {root,old,current,cliResolution:resolution,diagnosticScope:true,
    envelopeBinding:await make('assembly','bound_nonimage_envelope_calibration'),
    nativeBinding:await make('native','bound_native_schema_family_envelope_calibration')};
}
test('missing executable uses full uncalibrated floor, preserves historical bytes',async()=>{
  const input=await fixture(),before=await readFile(input.envelopeBinding.path),result=await resolve(input);
  assert.equal(result.envelopeCalibration,null);assert.equal(result.nativeEnvelopeCalibration,null);
  assert.equal(result.audit.uncalibrated_cli_allowance_tokens,6144);
  assert.equal(result.audit.excluded_calibrations.length,2);
  assert.equal(result.audit.old_calibration_allowance_used,false);
  assert.equal(result.audit.production_approval,false);
  assert.deepEqual(await readFile(input.envelopeBinding.path),before);
});
test('production and non-diagnostic scope cannot use fallback',async()=>{
  await assert.rejects(resolve({...await fixture(),diagnosticScope:false}),/fallback_scope/);
});
test('existing original executable cannot silently discard calibration',async()=>{
  const input=await fixture();input.cliResolution.requested_path=input.current;
  await assert.rejects(resolve(input),/not_missing/);
});
test('new executable content identity must remain exact',async()=>{
  const input=await fixture();await writeFile(input.current,'changed');
  await assert.rejects(resolve(input),/actual_executable_changed/);
});
test('historical calibration binding tampering fails',async()=>{
  const input=await fixture();await writeFile(input.envelopeBinding.path,'{}');
  await assert.rejects(resolve(input));
});
test('fallback profile cannot claim another historical CLI',async()=>{
  const input=await fixture(),value=JSON.parse(await readFile(input.nativeBinding.path,'utf8'));
  value.profile.cli.actual_path=input.current;input.nativeBinding=await saveJson(path.join(input.root,'mismatched-native.json'),value);
  await assert.rejects(resolve(input),/historical_binding_mismatch/);
});
test('unchanged no-calibration execution does not create fallback evidence',async()=>{
  const result=await resolve({cliResolution:{fallback_used:false}});
  assert.deepEqual(result,{envelopeCalibration:null,nativeEnvelopeCalibration:null,audit:null});
});
