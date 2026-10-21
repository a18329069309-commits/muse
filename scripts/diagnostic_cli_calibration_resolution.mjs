import path from 'node:path';
import {stat} from 'node:fs/promises';
import {readJson,verifyEvidenceBindings} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {loadNonImageEnvelopeCalibration} from './nonimage_envelope_calibration.mjs';

export const diagnosticCliCalibrationResolutionRevision='missing-app-cli-conservative-envelope-v1';

// Historical calibration is never relabelled for a different executable.
// Only diagnostic trials may use the existing, larger uncalibrated allowance.
export async function resolveDiagnosticEnvelopeCalibrations({envelopeBinding=null,nativeBinding=null,
  cliResolution,diagnosticScope=false}={}){
  const bindings={envelopeCalibration:envelopeBinding,nativeEnvelopeCalibration:nativeBinding};
  if(!cliResolution?.fallback_used){
    const result={};
    for(const [key,binding] of Object.entries(bindings))result[key]=binding?await loadNonImageEnvelopeCalibration(binding):null;
    return {...result,audit:null};
  }
  if(!diagnosticScope||cliResolution.resolution_kind!=='missing_configured_path_to_verified_codex_application_bin'
    ||!path.isAbsolute(cliResolution.requested_path??'')||!path.isAbsolute(cliResolution.actual_path??'')
    ||!/^codex-cli \d+\.\d+\.\d+(?:[-.][\w.]+)?$/i.test(cliResolution.version??'')
    ||!/^[a-f0-9]{64}$/i.test(cliResolution.actual_executable_sha256??''))
    throw Error('diagnostic_cli_calibration_fallback_scope_or_resolution_invalid');
  try{await stat(cliResolution.requested_path);throw Error('diagnostic_cli_calibration_original_executable_not_missing');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(await hashFile(cliResolution.actual_path)!==cliResolution.actual_executable_sha256)
    throw Error('diagnostic_cli_calibration_actual_executable_changed');
  const excluded=[];
  for(const [key,binding] of Object.entries(bindings)){
    if(!binding)continue;
    await verifyEvidenceBindings(binding);const historical=await readJson(binding.path);
    const expectedKind=key==='nativeEnvelopeCalibration'?'bound_native_schema_family_envelope_calibration':'bound_nonimage_envelope_calibration';
    if(historical.kind!==expectedKind||historical.schema_version!==1
      ||historical.production_approval!==false||historical.professional_qualification_granted!==false
      ||path.resolve(historical.profile?.cli?.actual_path??'')!==path.resolve(cliResolution.requested_path)
      ||!/^[a-f0-9]{64}$/i.test(historical.profile?.cli?.current_executable_sha256??''))
      throw Error('diagnostic_cli_calibration_historical_binding_mismatch');
    excluded.push({key,binding,historical_cli:historical.profile.cli,
      reason:'historical_executable_missing; calibration_not_revalidated_or_reused'});
  }
  return {envelopeCalibration:null,nativeEnvelopeCalibration:null,audit:{schema_version:1,
    revision:diagnosticCliCalibrationResolutionRevision,status:'diagnostic_uncalibrated_envelope',
    cli_resolution:structuredClone(cliResolution),excluded_calibrations:excluded,
    uncalibrated_cli_allowance_tokens:6144,old_calibration_allowance_used:false,
    historical_sample_evidence_revalidated:false,qualification_granted:false,production_approval:false}};
}
