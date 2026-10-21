import path from 'node:path';
import {stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {loadUploadDeploymentProfile} from './compose_uploaded_episode.mjs';
import {readJson,saveJson} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';
import {resolveCodexExecutable} from './compose_codex_episode.mjs';
import {isIndependentMusicPackTrial,validateIndependentMusicPackPolicy} from './independent_music_policy.mjs';
import {createCodexCliRuntime,structuredWorkerProfile} from './codex_cli_runtime.mjs';
import {resolveDiagnosticEnvelopeCalibrations} from './diagnostic_cli_calibration_resolution.mjs';

const execute=promisify(execFile);
const skillRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const options={windowsHide:true,timeout:20000,maxBuffer:1024*1024};
const moduleProbe='import importlib.util,json,sys; print(json.dumps({m:importlib.util.find_spec(m) is not None for m in sys.argv[1:]}))';

// Shared startup/launcher semantics. Pure runtime construction submits no model
// request and creates no state; missing-CLI fallback never requalifies old samples.
export async function diagnoseStartupEnvelopeProfile({profile,cliResolution,output_dir}){
  if(!cliResolution)throw Error('startup_codex_executable_required_for_calibration');
  const options=profile.codex_cli??{};
  const resolved=await resolveDiagnosticEnvelopeCalibrations({envelopeBinding:options.envelope_calibration,
    nativeBinding:options.native_envelope_calibration,cliResolution,
    diagnosticScope:isIndependentMusicPackTrial(profile)&&profile.quality_review_policy==='diagnostic_only'});
  createCodexCliRuntime({stateDirectory:path.join(output_dir,'.startup-state'),
    archiveDirectory:path.join(output_dir,'.startup-archive'),cwd:options.cwd??skillRoot,
    codexPath:cliResolution.actual_path,model:options.model??'gpt-6.1-sol',
    transport:options.transport??(profile.material_strategy==='independent_music_packs'?'chatgpt_https':'codex_default'),
    workerProfile:options.worker_profile??structuredWorkerProfile,businessContract:options.business_contract??null,
    contactSheetProfile:profile.contact_sheet_profile??null,stageReasoningEffort:options.stageReasoningEffort??{},
    envelopeCalibration:resolved.envelopeCalibration,nativeEnvelopeCalibration:resolved.nativeEnvelopeCalibration});
  if(resolved.audit)return{status:resolved.audit.status,profile_verified:false,actual_receipt_count:0,
    calibration_resolution:resolved.audit,uncalibrated_cli_allowance_tokens:resolved.audit.uncalibrated_cli_allowance_tokens,
    account_requests:0,model_forward_calls:0,qualification_granted:false,production_approval:false};
  const calibrations=[resolved.envelopeCalibration,resolved.nativeEnvelopeCalibration].filter(Boolean);
  for(const calibration of calibrations)if(path.resolve(cliResolution.actual_path)!==path.resolve(calibration.profile.cli.actual_path)
    ||await hashFile(cliResolution.actual_path)!==calibration.profile.cli.current_executable_sha256)
    throw Error('envelope_calibration_profile_mismatch');
  return{actual_receipt_count:calibrations.reduce((sum,row)=>sum+row.samples.length,0),profile_verified:true,
    native_calibration_stage_profile_checked:Boolean(resolved.nativeEnvelopeCalibration),
    context_floor_estimate_is_provider_guarantee:false,account_requests:0,model_forward_calls:0,
    qualification_granted:false,production_approval:false};
}

// Read-only checks before expensive preparation or account calls. Module discovery loads no weights.
export async function diagnoseSkillStartup({deployment,output_dir,check_modules=true}){
  if(!path.isAbsolute(deployment??'')||!path.isAbsolute(output_dir??''))
    throw Error('startup_absolute_profile_and_output_required');
  const checks=[];
  async function check(id,operation){
    try{const detail=await operation();checks.push({id,status:'passed',detail:detail??null});return detail;}
    catch(error){checks.push({id,status:'failed',reason:error.message});return null;}
  }
  async function resource(id,file,expected){
    return check(id,async()=>{
      if(!path.isAbsolute(file??''))throw Error('resource_absolute_path_required');
      const info=await stat(file);
      if(!info.isFile()||info.size===0)throw Error('nonempty_resource_file_required');
      if(expected&&await hashFile(file)!==expected)throw Error('frozen_resource_sha256_mismatch');
      return{path:file,bytes:info.size,sha256_verified:Boolean(expected)};
    });
  }
  async function directory(id,file){
    return check(id,async()=>{
      if(!path.isAbsolute(file??'')||!(await stat(file)).isDirectory())throw Error('resource_directory_required');
      return{path:file};
    });
  }
  async function modules(id,python,names,extraPaths=[]){
    return check(id,async()=>{
      const extra=extraPaths.filter(Boolean),environment={...process.env,PYTHONUTF8:'1',
        HF_HUB_OFFLINE:'1',MODELSCOPE_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'};
      if(extra.length)environment.PYTHONPATH=[...extra,process.env.PYTHONPATH].filter(Boolean).join(path.delimiter);
      const result=await execute(python,['-X','utf8','-c',moduleProbe,...names],{...options,env:environment});
      const available=JSON.parse(result.stdout.trim()),missing=names.filter(name=>available[name]!==true);
      if(missing.length)throw Error(`python_modules_missing:${missing.join(',')}`);
      return{python,modules:names,weights_loaded:false,forward_calls:0};
    });
  }
  const profile=await check('upload_profile',()=>loadUploadDeploymentProfile(deployment));
  if(profile){
    // Avoid copying the full runtime configuration into a public diagnostic report.
    checks.at(-1).detail={assembly_contract_version:profile.assembly_contract_version??1,
      material_strategy:profile.material_strategy??'reference_original',mode:profile.mode};
    if(profile.material_strategy==='independent_music_packs')await check('independent_output_scope',async()=>{
      await validateIndependentMusicPackPolicy(profile,{outputDirectory:output_dir,operation:'compose_uploaded_episode'});
      return{authorized_output:output_dir,production_approval:false};
    });
    for(const[kind,library]of[['music',profile.library],['sfx',profile.sfx_library],['ambient',profile.ambient_library]])
      if(library)await resource(`${kind}_frozen_database`,library.db,library.sha256);
    // Read-only readiness: an absent shared target is a preparation task,
    // never something to discover after consuming a film's model budget.
    // Existence alone does not prove write/atomic-publication readiness.
    if(profile.delivery_archive)await directory('delivery_archive_root',profile.delivery_archive.archive_root);
    if(profile.cases?.db)await resource('case_database',profile.cases.db,profile.cases.sha256);
    if(profile.music_packs)await resource('music_publication',profile.music_packs.path,profile.music_packs.sha256);
    if(profile.codex_cli?.envelope_calibration)await resource('codex_envelope_calibration',
      profile.codex_cli.envelope_calibration.path,profile.codex_cli.envelope_calibration.sha256);
    for(const name of ['ffmpeg','ffprobe'])await check(name,async()=>{
      const result=await execute(name,['-version'],options);return{version:result.stdout.split(/\r?\n/)[0]};
    });
    const codex=await check('codex_executable',async()=>{
      const resolved=await resolveCodexExecutable({requestedPath:profile.codex_cli?.path??'codex'});
      const result=await execute(resolved.actual_path,['--version'],options),version=result.stdout.trim();
      if(!/^codex-cli \d+\.\d+\.\d+(?:[-.][\w.]+)?$/i.test(version))throw Error('codex_version_unrecognized');
      return{...resolved,version,authentication:'not_checked',account_requests:0};
    });
    if(profile.codex_cli?.cwd)await directory('codex_working_directory',profile.codex_cli.cwd);
    if(profile.codex_cli?.envelope_calibration||profile.codex_cli?.native_envelope_calibration)
      await check('codex_envelope_profile',()=>diagnoseStartupEnvelopeProfile({profile,cliResolution:codex,output_dir}));
    // Match the actual launcher: an assembly-only calibration cannot silently
    // satisfy the typed director's separate native-schema stage requirement.
    if(profile.codex_cli?.director_contract==='typed_bounded_v1'&&!profile.codex_cli.native_envelope_calibration)
      await check('codex_native_calibration_required',async()=>{throw Error('local_ready_native_calibration_required');});
    if(profile.local_audio_analysis){
      const model=profile.local_audio_analysis.model_dir;
      if(model)await resource('source_audio_model',path.join(model,'model.pt'));
      if(profile.local_audio_analysis.module_directory)
        await directory('source_audio_module_directory',profile.local_audio_analysis.module_directory);
    }
    if(check_modules){
      await modules('render_python',profile.python??'python',['numpy','soundfile','scipy']);
      await modules('contact_sheet_python',profile.contact_sheet_python??profile.python??'python',['PIL']);
      if(profile.local_audio_analysis)await modules('source_audio_python',profile.local_audio_python??profile.python??'python',
        ['numpy','soundfile','torch','funasr','silero_vad'],[profile.local_audio_analysis.module_directory]);
    }
    const observation=profile.material_observation_execution;
    for(const[index,file]of(observation?.model_configs??[]).entries()){
      const config=await check(`observer_config_${index}`,()=>readJson(file));
      if(!config)continue;
      checks.at(-1).detail={path:file,backend:config.backend,model_revision:config.model_revision??null};
      const id=`observer_${index}`;
      if(config.backend==='panns_sed'){
        await resource(`${id}_model`,config.model_path,config.model_sha256);
        await resource(`${id}_labels`,config.labels_file);
      }else if(config.backend==='qwen3_asr')await directory(`${id}_model_directory`,config.model_path);
      else checks.push({id:`${id}_backend`,status:'failed',reason:'startup_probe_backend_not_supported'});
      if(check_modules){
        const names=config.backend==='panns_sed'?['numpy','soundfile','torch','panns_inference']:
          config.backend==='qwen3_asr'?['numpy','soundfile','torch','transformers']:null;
        if(names)await modules(`${id}_python`,observation.python??profile.python??'python',names,
          [observation.environment?.PYTHONPATH]);
      }
    }
    const retriever=profile.independent_retriever;
    if(retriever){
      const frozen=await resource('clap_snapshot',retriever.snapshot?.path,retriever.snapshot?.sha256);
      if(frozen){
        const snapshot=await check('clap_snapshot_contract',async()=>{
          const value=await readJson(retriever.snapshot.path);
          if(value.kind!=='independent_resident_clap_snapshot'
            ||!Object.keys(value.model_binding?.model_files??{}).length)throw Error('startup_clap_snapshot_contract_invalid');
          return value;
        });
        if(snapshot){
          checks.at(-1).detail={kind:snapshot.kind,windows:snapshot.target_windows??null};
          for(const key of ['index','audio','mapping','music_publication']){
            const binding=snapshot[key];await resource(`clap_${key}`,binding?.path,binding?.sha256);
          }
          for(const[name,sha256]of Object.entries(snapshot.model_binding.model_files)){
            if(path.basename(name)!==name)checks.push({id:`clap_weight:${name}`,status:'failed',reason:'clap_model_member_name_invalid'});
            else await resource(`clap_weight:${name}`,path.join(retriever.weights??'',name),sha256);
          }
        }
      }
      if(check_modules)await modules('clap_python',retriever.python??profile.python??'python',
        ['numpy','soundfile','torch','transformers']);
    }
  }
  const gaps=checks.filter(row=>row.status==='failed');
  return{schema_version:1,kind:'skill_readonly_startup_diagnostic',deployment,
    status:gaps.length?'startup_gap':'startup_dependencies_verified',checks,gaps,
    checked_python_modules:check_modules,account_requests:0,model_forward_calls:0,
    media_processed:false,media_inventory_verified:false,authentication_verified:false,
    sound_qualification_granted:false,production_approval:false,automatic_scoring_acceptance:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const{values}=parseArgs({options:{profile:{type:'string'},out:{type:'string'},report:{type:'string'},
      'skip-modules':{type:'boolean',default:false}}});
    const result=await diagnoseSkillStartup({deployment:values.profile,output_dir:values.out,check_modules:!values['skip-modules']});
    if(values.report){if(!path.isAbsolute(values.report))throw Error('startup_report_absolute_path_required');await saveJson(values.report,result);}
    console.log(JSON.stringify(result,null,2));if(result.gaps.length)process.exitCode=2;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
