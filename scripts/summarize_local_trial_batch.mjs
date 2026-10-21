// Read-only benchmark of controller/ledger/render evidence. Never launches a
// worker, decodes source media, resets a ledger or infers listening acceptance.
import path from 'node:path';
import {readFile,readdir,mkdir,writeFile,stat,open} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {hashFile} from './render_binding.mjs';
import {resolveVerifiedRecordingFamily} from './music_family_identity.mjs';
import {verifyPostRenderQualityReview} from './post_render_quality_review.mjs';

const canonicalPath=file=>path.resolve(file).toLowerCase();
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const positive=value=>Number.isFinite(value)&&value>0;
const stamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):null;
const fixture=value=>value?.fixture_only===true||value?.test_fixture_only===true||value?.probe_fixture_only===true
  ||value?.execution_kind==='injected_test_transport';
export function percentiles(values){
  const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);
  const at=p=>sorted.length?sorted[Math.ceil(p*sorted.length)-1]:null;
  return {count:sorted.length,p50:at(.5),p95:at(.95),method:'nearest_rank'};
}
async function discover(root){
  const files=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    if(entry.isDirectory())files.push(...await discover(path.join(root,entry.name)));
    else if(entry.isFile()&&entry.name==='automatic-state.json')files.push(path.join(root,entry.name));
  }
  return files;
}
const processExists=pid=>{
  if(!Number.isInteger(pid)||pid<1)return null;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='ESRCH'?false:null;}
};

export async function summarizeLocalTrialBatch({roots=[],state_files=[],upload_batch,output_dir,
  now_ms=Date.now(),workers=1,process_probe=processExists}={}){
  if(!Number.isFinite(now_ms)||!Number.isInteger(workers)||workers<1)throw Error('benchmark_clock_or_workers_invalid');
  const inputFiles=[...state_files];
  for(const root of roots)inputFiles.push(...await discover(path.resolve(root)));
  const evidence=[],gaps=[],jsonCache=new Map(),hashCache=new Map();
  const json=async(ref,label)=>{
    const file=typeof ref==='string'?path.resolve(ref):path.resolve(ref.path),expected=typeof ref==='string'?null:ref.sha256;
    const key=canonicalPath(file);let row=jsonCache.get(key);
    if(!row){const bytes=await readFile(file);row={value:JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')),binding:{path:file,sha256:digest(bytes)}};
      jsonCache.set(key,row);evidence.push({kind:label,...row.binding});}
    if(expected&&row.binding.sha256!==expected)throw Error('benchmark_bound_evidence_changed');
    return row.value;
  };
  const checkFile=async(ref,samples)=>{
    if(!ref?.path||!/^[a-f0-9]{64}$/.test(ref.sha256??''))throw Error('benchmark_output_binding_required');
    const key=canonicalPath(ref.path);if(!hashCache.has(key))hashCache.set(key,await hashFile(ref.path));
    if(hashCache.get(key)!==ref.sha256)throw Error('benchmark_output_changed');
    const header=Buffer.alloc(44),handle=await open(ref.path,'r');
    try{await handle.read(header,0,44,0);}finally{await handle.close();}
    if(header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,16)!=='WAVEfmt '
      ||header.readUInt16LE(20)!==1||header.readUInt16LE(22)!==2||header.readUInt32LE(24)!==48000
      ||header.readUInt16LE(34)!==24||header.toString('ascii',36,40)!=='data'
      ||header.readUInt32LE(40)!==samples*6||(await stat(ref.path)).size!==44+samples*6)
      throw Error('benchmark_actual_pcm_clock_required');
  };
  const rows=[];
  for(const file of [...new Map(inputFiles.map(file=>[canonicalPath(file),path.resolve(file)])).values()]){
    try{
      const state=await json(file,'controller_state');
      if(state.kind!=='automatic_episode_controller'||fixture(state)){gaps.push({path:file,reason:'not_a_real_episode_controller'});continue;}
      const source=state.source;
      if(!source?.path||!/^[a-f0-9]{64}$/.test(source.sha256??''))throw Error('benchmark_state_source_required');
      const root=path.dirname(file),budgetFile=path.join(root,'independent-trial-budget','state.json');
      let budget=null;
      try{budget=await json(budgetFile,'film_budget');
        if(budget.identity?.source_video_sha256!==source.sha256||canonicalPath(budget.identity.output_root)!==canonicalPath(root))
          throw Error('benchmark_ledger_identity_mismatch');
      }catch(error){budget=null;gaps.push({path:budgetFile,reason:error.code==='ENOENT'?'film_budget_missing':error.message});}
      const renders=[];
      for(const registration of state.render_registry??[]){
        try{
          if(registration.source_video?.sha256!==source.sha256)throw Error('benchmark_render_source_changed');
          const result=await json(registration.rendered_result,'render_result');
          if(fixture(result)||fixture(result.render))throw Error('benchmark_render_fixture_excluded');
          const render=result.render,outputs=render?.outputs;
          if(!['validate_inputs','prepare_original_audio','render','check_sound_coverage']
            .every(name=>render?.stages?.some(stage=>stage.name===name&&stage.status==='completed')))
            throw Error('benchmark_actual_completed_render_required');
          const reportRef=outputs['render/report.json'],planRef=outputs['plan.json'],manifestRef=outputs['media/manifest.json'];
          const report=await json(reportRef,'render_pcm_report'),plan=await json(planRef,'render_plan'),manifest=await json(manifestRef,'render_manifest');
          if(fixture(report)||report.source_sha256!==source.sha256||manifest.source_sha256!==source.sha256
            ||report.sample_rate!==48000||report.channels!==2||!Number.isSafeInteger(report.duration_samples)||report.duration_samples<=0
            ||report.input_binding?.plan_sha256!==planRef.sha256||report.input_binding?.manifest_sha256!==manifestRef.sha256)
            throw Error('benchmark_render_clock_or_input_binding_invalid');
          for(const track of ['bgm','sfx','ambience','accompaniment']){
            if(outputs[track]?.sha256!==report.output_sha256?.[track])throw Error('benchmark_stem_receipt_mismatch');
            await checkFile(outputs[track],report.duration_samples);
          }
          const sfxPcm=await readFile(outputs.sfx.path);
          if(digest(sfxPcm)!==outputs.sfx.sha256)throw Error('benchmark_output_changed');
          const full=!result.diagnostic_sample&&manifest.timeline?.sample_rate===48000
            &&report.duration_samples===manifest.timeline.duration_samples
            &&(!result.duration_samples||result.duration_samples===report.duration_samples);
          const music=[];
          for(const cue of report.cues??[]){
            if(cue.track!=='bgm')continue;
            const sha=report.input_binding.asset_sha256?.[cue.asset_id];
            const seconds=Math.max(0,Math.min(report.duration_samples,cue.end_sample)-Math.max(0,cue.rendered_start_sample??cue.start_sample))/48000;
            if(!/^[a-f0-9]{64}$/.test(sha??'')||!positive(seconds))continue;
            let family=null;
            const claimed=render.cross_work_music?.current?.recording_family_by_sha256?.[sha];
            if(claimed?.identity_basis==='hash_bound_verified_recording_family_membership')try{
              family=await resolveVerifiedRecordingFamily({source_sha256:sha,
                family_identity:{status:'verified',family_id:claimed.family_id,evidence:claimed.evidence}});
            }catch(error){gaps.push({path:registration.rendered_result.path,reason:error.message});}
            music.push({key:family?`family:${family.family_id}`:`recording:${sha}`,seconds,verified_family:Boolean(family)});
          }
          const technical=report.status==='technical_ok'&&(report.issues??[]).length===0
            &&render.mix_status==='technical_ok'&&render.coverage_status==='coverage_ready_for_audition';
          renders.push({render_id:registration.render_id,registration,result,full,technical,music,
            nonzero_sfx:sfxPcm.subarray(44).some(value=>value!==0),
            duration_seconds:report.duration_samples/48000,registered_at:registration.registered_at});
        }catch(error){gaps.push({path:registration.rendered_result?.path??file,reason:error.message});}
      }
      rows.push({file,root,state,source,budget,renders});
    }catch(error){gaps.push({path:file,reason:error.message});}
  }
  const bySource=new Map();
  for(const row of rows){const values=bySource.get(row.source.sha256)??[];values.push(row);bySource.set(row.source.sha256,values);}
  const episodes=[],requestIds=new Map(),ledgerIds=new Set(),stageDurations={};
  for(const [sha,versions] of bySource){
    versions.sort((a,b)=>(stamp(a.state.updated_at)??0)-(stamp(b.state.updated_at)??0));
    const current=versions.at(-1),{state}=current,activePid=current.budget?.active_run?.pid;
    const alive=activePid?await process_probe(activePid):null;
    const active=Object.values(state.stages??{}).some(stage=>stage.status==='running');
    const category=active?(alive===true?'active':alive===false?'stale_active_record':'recorded_active_unverified')
      :Object.values(state.stages??{}).some(stage=>['waiting','pending'].includes(stage.status))?'waiting'
      :state.status==='automatic_host_response_pending'?'waiting':current.renders.length?'rendered':'needs_attention';
    const attempts=new Map(),renderIds=new Map(),registrations=new Map();let activeMs=0,budgetComplete=true;
    for(const row of versions){
      for(const [name,stage] of Object.entries(row.state.stages??{}))attempts.set(name,Math.max(attempts.get(name)??0,stage.attempt??0));
      for(const stage of row.state.stage_attempt_history??[])attempts.set(stage.stage,Math.max(attempts.get(stage.stage)??0,stage.attempt??0));
      for(const registration of row.state.render_registry??[])registrations.set(registration.render_id??registration.rendered_result?.sha256,registration);
      for(const render of row.renders)renderIds.set(render.render_id??render.registration.rendered_result.sha256,render);
      const budget=row.budget;
      if(!budget){budgetComplete=false;continue;}
      const ledgerKey=canonicalPath(budget.identity.output_root);
      if(ledgerIds.has(ledgerKey))continue;ledgerIds.add(ledgerKey);
      for(const request of budget.requests??[]){
        const key=sha+':'+request.id;const prior=requestIds.get(key);
        if(!prior||prior.confirmed_invocations===null&&Number.isInteger(request.confirmed_invocations))requestIds.set(key,request);
      }
      if(!Array.isArray(budget.run_history)){budgetComplete=false;continue;}
      for(const run of budget.run_history){
        if(!Number.isFinite(run.started_at_ms)||!Number.isFinite(run.finished_at_ms)||run.finished_at_ms<run.started_at_ms){budgetComplete=false;continue;}
        activeMs+=run.finished_at_ms-run.started_at_ms;
      }
      if(budget.active_run){budgetComplete=false;
        const end=alive===true?now_ms:stamp(row.state.updated_at);
        if(end!==null)activeMs+=Math.max(0,end-budget.active_run.started_at_ms);}
    }
    for(const [name,stage] of Object.entries(state.stages??{})){
      const start=stamp(stage.started_at),end=stamp(stage.finished_at);
      if(start!==null&&end!==null&&end>=start)(stageDurations[name]??=[]).push(end-start);
    }
    const renders=[...renderIds.values()].sort((a,b)=>(stamp(a.registered_at)??0)-(stamp(b.registered_at)??0));
    const full=renders.filter(render=>render.full),latest=renders.at(-1);
    const latestRegistered=[...registrations.values()].sort((a,b)=>(stamp(a.registered_at)??0)-(stamp(b.registered_at)??0)).at(-1);
    const latestVerified=Boolean(latest&&latest.registration.rendered_result.sha256===latestRegistered?.rendered_result?.sha256);
    let listening=false;
    if(state.stages?.quality_review?.result_binding&&state.quality_readiness&&latest)try{
      const readiness=await json(state.quality_readiness,'quality_readiness');
      const verified=await verifyPostRenderQualityReview(state.stages.quality_review.result_binding,
        {source:current.source,render_binding:latest.registration.rendered_result,
          render_files:latest.registration.files??[],readiness});
      listening=latestVerified&&verified.accepted===true;
    }catch(error){gaps.push({path:state.stages.quality_review.result_binding.path,reason:error.message});}
    const start=Math.min(...versions.map(row=>stamp(row.state.created_at)??Infinity)),end=stamp(latest?.registered_at);
    episodes.push({source_sha256:sha,video:current.source.path,state_file:current.file,status:state.status,category,
      recorded_stage:Object.entries(state.stages??{}).find(([,stage])=>stage.status==='running')?.[0]??null,
      active_process_exists:alive,stage_attempts:Object.fromEntries(attempts),
      retry_required:[...attempts.values()].some(attempt=>attempt>1),render_attempts:registrations.size,
      verified_render_attempts:renders.length,latest_registered_render_verified:latestVerified,
      full_episode_renders:full.length,technical_accepted:latestVerified&&latest?.full===true&&latest.technical,
      listening_accepted:listening,nonzero_sfx:latest?.nonzero_sfx??null,
      full_episode_duration_seconds:latest?.full?latest.duration_seconds:null,
      first_pass_technical:latestVerified&&full[0]?.technical===true&&full[0]===renders[0]&&registrations.size===1&&![...attempts.values()].some(attempt=>attempt>1),
      active_elapsed_ms:activeMs,completed_active_elapsed_ms:latestVerified&&latest?.full&&budgetComplete&&positive(activeMs)?activeMs:null,
      full_render_wall_elapsed_ms:end!==null&&Number.isFinite(start)&&end>=start?end-start:null,
      music:latest?.music??[],ledger_complete:budgetComplete});
  }
  let planned=[];
  if(upload_batch){const batch=await json(upload_batch,'upload_batch');
    if(!Array.isArray(batch.episodes))throw Error('benchmark_upload_batch_episodes_required');
    planned=batch.episodes.map(item=>({episode_id:item.episode_id,video:item.video,
      status:episodes.some(episode=>canonicalPath(episode.video)===canonicalPath(item.video))?'started':'not_started'}));}
  const counts={controller_states:rows.length,started_source_episodes:episodes.length,prepared_upload_episodes:planned.length,
    prepared_not_started:planned.filter(row=>row.status==='not_started').length,
    active:episodes.filter(row=>row.category==='active').length,waiting:episodes.filter(row=>row.category==='waiting').length,
    stale_active_records:episodes.filter(row=>row.category==='stale_active_record').length,
    recorded_active_unverified:episodes.filter(row=>row.category==='recorded_active_unverified').length,
    needs_attention:episodes.filter(row=>row.category==='needs_attention').length,
    confirmed_account_invocations:[...requestIds.values()].reduce((sum,row)=>sum+(Number.isInteger(row.confirmed_invocations)?row.confirmed_invocations:0),0),
    reserved_or_unknown_invocations:[...requestIds.values()].filter(row=>!Number.isInteger(row.confirmed_invocations)).length,
    full_episode_audio_rendered:episodes.filter(row=>row.full_episode_renders>0).length,
    technical_accepted:episodes.filter(row=>row.technical_accepted).length,listening_accepted:episodes.filter(row=>row.listening_accepted).length,
    first_pass_technical:episodes.filter(row=>row.first_pass_technical).length,retried_episodes:episodes.filter(row=>row.retry_required).length,
    render_repair_episodes:episodes.filter(row=>row.render_attempts>1).length,
    nonzero_sfx_episodes:episodes.filter(row=>row.nonzero_sfx===true).length};
  const time={unit:'milliseconds',stage_basis:'current_finished_stage_attempt; closed_film_ledger_active_time_includes_retries',
    completed_full_episode_active:percentiles(episodes.map(row=>row.completed_active_elapsed_ms).filter(value=>value!==null)),
    completed_full_episode_wall:percentiles(episodes.filter(row=>row.full_episode_renders>0).map(row=>row.full_render_wall_elapsed_ms).filter(value=>value!==null)),
    stages:Object.fromEntries(Object.entries(stageDurations).map(([name,values])=>[name,percentiles(values)]))};
  const musicTotals=new Map();let musicSeconds=0;
  for(const episode of episodes)for(const item of episode.music){musicSeconds+=item.seconds;
    const row=musicTotals.get(item.key)??{key:item.key,seconds:0,episode_sources:new Set(),verified_family:item.verified_family};
    row.seconds+=item.seconds;row.episode_sources.add(episode.source_sha256);musicTotals.set(item.key,row);}
  const concentration=[...musicTotals.values()].map(row=>({...row,episode_sources:row.episode_sources.size,
    placed_music_share:musicSeconds?row.seconds/musicSeconds:null})).sort((a,b)=>b.seconds-a.seconds);
  const eligible=episodes.filter(row=>row.full_episode_renders>0&&row.completed_active_elapsed_ms!==null);
  const accepted=eligible.filter(row=>row.technical_accepted).length;
  const capacity={status:'insufficient_evidence',targets_per_month:[8000,16000],complete_timed_episode_samples:eligible.length,
    reason:!eligible.length?'no_verified_complete_episode_with_closed_film_ledger':'no_technically_accepted_complete_episode_in_timed_sample',
    projected_episodes_per_month:null,required_workers:null};
  if(eligible.length&&accepted){const duration=percentiles(eligible.map(row=>row.completed_active_elapsed_ms)),yieldRate=accepted/eligible.length,
      monthlyMs=30*24*3600000,perWorkerP50=monthlyMs/duration.p50*yieldRate,perWorkerP95=monthlyMs/duration.p95*yieldRate;
    Object.assign(capacity,{status:'conditional_full_episode_sample_projection',reason:null,assumed_workers:workers,
      technical_yield:yieldRate,assumed_available_hours_per_worker_per_month:720,
      projected_episodes_per_month:{using_p50:perWorkerP50*workers,using_p95:perWorkerP95*workers},
      required_workers:capacity.targets_per_month.map(target=>({target,using_p50:Math.ceil(target/perWorkerP50),using_p95:Math.ceil(target/perWorkerP95)})),
      limitations:['Conditional linear arithmetic on complete film active time, including retries; account/concurrency limits and queue waiting are not measured sustainable throughput.',
        'Technical acceptance and qualified listening acceptance are separate. Window/GPU/library preparation timings are never inputs.']});}
  const summary={schema_version:1,kind:'local_trial_batch_benchmark',as_of:new Date(now_ms).toISOString(),
    counts,time,music_concentration:{basis:'latest_bound_render_music_placement_seconds_per_source; verified_family_else_exact_recording',
      placed_music_seconds:musicSeconds,distinct_keys:concentration.length,top_share:concentration[0]?.placed_music_share??null,rows:concentration},
    capacity,episodes,prepared_uploads:planned,evidence,gaps,account_calls_by_report:0,new_model_calls_by_report:0,
    qualification_granted:false,production_approval:false};
  if(output_dir){await mkdir(output_dir,{recursive:true});
    await writeFile(path.join(output_dir,'summary.json'),JSON.stringify(summary,null,2)+'\n');
    const report=`# 本地试片批次实测\n\n截至 ${summary.as_of}。报告没有账户调用或新模型推理。\n\n`
      +`已开始 ${counts.started_source_episodes} 个源；待启动上传 ${counts.prepared_not_started}/${counts.prepared_upload_episodes}。活动 ${counts.active}，等待 ${counts.waiting}，残留活动记录 ${counts.stale_active_records}。\n\n`
      +`账户调用：已确认 ${counts.confirmed_account_invocations}，预留/结果未决 ${counts.reserved_or_unknown_invocations}。整集音轨渲染 ${counts.full_episode_audio_rendered}；技术验收 ${counts.technical_accepted}，合格听审验收 ${counts.listening_accepted}。\n\n`
      +`技术首过 ${counts.first_pass_technical}，有阶段重试 ${counts.retried_episodes}，多次渲染返修 ${counts.render_repair_episodes}；非零 SFX ${counts.nonzero_sfx_episodes}。\n\n`
      +`整集闭合账本活动时长 P50/P95：${time.completed_full_episode_active.p50??'无样本'} / ${time.completed_full_episode_active.p95??'无样本'} ms。\n\n`
      +`月产 8000–16000 集评估：${capacity.status}。${capacity.reason??'基于完整整集样本的条件线性投影，未验证可持续账户并发或排队吞吐。'}\n\n`
      +`曲目集中度按最近绑定渲染的实际摆放时长计算；合格家族证据缺失时按录音 SHA 分组。当前 ${concentration.length} 组。详细状态、证据、P50/P95 与限制见 summary.json。\n`;
    await writeFile(path.join(output_dir,'summary.md'),report);}
  return summary;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{root:{type:'string',multiple:true},state:{type:'string',multiple:true},
    'upload-batch':{type:'string'},out:{type:'string'},workers:{type:'string'}}});
  const result=await summarizeLocalTrialBatch({roots:values.root??[],state_files:values.state??[],
    upload_batch:values['upload-batch'],output_dir:values.out,workers:values.workers?Number(values.workers):1});
  process.stdout.write(JSON.stringify({counts:result.counts,capacity:result.capacity,
    output_dir:values.out?path.resolve(values.out):null,gaps:result.gaps.length})+'\n');
}
