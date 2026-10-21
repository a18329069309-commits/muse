import path from 'node:path';
import {realpath,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hashFile} from './render_binding.mjs';
import {resolveDiagnosticEnvelopeCalibrations} from './diagnostic_cli_calibration_resolution.mjs';

const execute=promisify(execFile);
const missingApplicationKind='missing_configured_path_to_verified_codex_application_bin';

// Preserve historical resolution semantics. The new kind is independently
// rechecked against the current trusted application executable; this never
// relabels or reuses a calibration made for the missing old executable.
export async function isActualCodexCliResolution(resolution){
  if(['configured_path','verified_application_fallback'].includes(resolution?.resolution_kind))return true;
  if(resolution?.resolution_kind!==missingApplicationKind||resolution.injected===true
    ||resolution.fallback_used!==true||resolution.logical_configuration_unchanged!==true
    ||!path.isAbsolute(resolution.requested_path??'')||!path.isAbsolute(resolution.actual_path??'')
    ||path.resolve(resolution.requested_path)===path.resolve(resolution.actual_path))return false;
  try{
    const trusted=path.join(process.env.LOCALAPPDATA??path.join(process.env.USERPROFILE??'','AppData','Local'),
      'OpenAI','Codex','bin');
    if(!path.isAbsolute(trusted))return false;
    const base=await realpath(trusted),actual=await realpath(resolution.actual_path);
    const relative=path.relative(base,actual);
    if(actual!==path.resolve(resolution.actual_path)||!/^([a-f0-9]{16,64})[\\/]codex\.exe$/i.test(relative)
      ||!(await stat(actual)).isFile())return false;
    await resolveDiagnosticEnvelopeCalibrations({cliResolution:resolution,diagnosticScope:true});
    const version=(await execute(actual,['--version'],{windowsHide:true,timeout:10000,maxBuffer:4096})).stdout.trim();
    return version===resolution.version&&/^codex-cli \d+\.\d+\.\d+(?:[-.][\w.]+)?$/i.test(version)
      &&await hashFile(actual)===resolution.actual_executable_sha256;
  }catch{return false;}
}
