import { projectTrialPreflight } from './project_trial_gate.mjs';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { hashFile } from './render_binding.mjs';
import { renderPlan } from './render_audio.mjs';
import {verifyFinalMixMaster} from './final_mix_master.mjs';
import { hashCreativePlan, validateCreativeHandoff } from './validate_creative_handoff.mjs';
import { enforceEpisodeMusicSourceBudget } from './music_source_delivery_gate.mjs';
import { hasIndependentMusicPackFields, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { enforceCrossWorkDominantMusic, registerCompletedMusicDelivery,
  acquireProjectMusicRenderLock, releaseProjectMusicRenderLock, startProjectMusicRenderHeartbeat } from './cross_work_music_gate.mjs';
import { recordIndependentWorkerSpawn } from './music_render_reservations.mjs';
import { runOwnedEpisodeTask } from './owned_process_runner.mjs';

const execute = promisify(execFile);
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
const resolveInput = (base, value, label) => {
  if (typeof value !== 'string' || !value) throw new Error(`${label} must be a file path`);
  return path.resolve(base, value);
};
const errorMessage = error => error instanceof SyntaxError ? 'Invalid JSON in job or input records'
  : error.code ? `File operation failed (${error.code})` : error.message;

// This runner executes a completed local sound plan. It does not analyze story, generate assets, or approve listening quality.
export async function runSoundJob(jobFile, outputDirectory, { policyPath, cwd, trialBudget, python } = {}) {
  if (trialBudget?.identity?.wall_clock_policy)
    return runOwnedEpisodeTask('run_sound_job', [jobFile, outputDirectory, { policyPath, cwd }], {
      outputDirectory: path.resolve(outputDirectory), trialBudget, python });
  const deadline = process.env.SDR_EPISODE_DEADLINE_AT_MS;
  const checkDeadline = () => {
    if (deadline !== undefined && (!Number.isSafeInteger(Number(deadline)) || Date.now() >= Number(deadline)))
      throw Error('sound_job_absolute_deadline_exhausted');
  };
  checkDeadline();
  const projectGate = await projectTrialPreflight({ output_dir: outputDirectory }, { operation: 'run_sound_job', inputFiles: [path.resolve(jobFile)], policyPath, cwd });
  if (projectGate) return projectGate;

  const started = performance.now(), jobPath = path.resolve(jobFile), output = path.resolve(outputDirectory);
  try {
    if ((await readdir(output)).length) throw new Error('Output directory must be empty; use a new directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(output, { recursive: true });
  const record = { schema_version: 1, status: 'running', started_at: new Date().toISOString(), job_file: jobPath, inputs: {},
    stages: [], original_audio_processing: null, outputs: {}, production_approval: false,
    artistic_acceptance: 'not_assessed', audible_sync_review: 'not_performed',
    external_stages: { video_story_analysis: 'not_executed_by_runner', music_direction: 'not_executed_by_runner',
      asset_retrieval_or_generation: 'not_executed_by_runner', listening_review: 'not_executed_by_runner' } };
  const stage = async (name, action) => {
    checkDeadline();
    const began = performance.now(), item = { name, status: 'running' };
    record.stages.push(item);
    try { const value = await action(); checkDeadline(); item.status = 'completed'; return value; }
    catch (error) { item.status = 'failed'; throw error; }
    finally { item.elapsed_seconds = (performance.now() - began) / 1000; }
  };
  let musicRenderReservation = null;
  let musicRenderHeartbeat = null;
  const executeBoundWorker = async (command, parameters, options) => {
    if (musicRenderReservation?.kind !== 'independent_render_reservation') return execute(command, parameters, options);
    const spawnId = await recordIndependentWorkerSpawn(musicRenderReservation);
    let result;
    try {
      result = execute(command, parameters, options);
      result.catch(() => {}); // Persist ownership before awaiting process completion.
      if (result.child?.pid) await recordIndependentWorkerSpawn(musicRenderReservation, { spawnId, pid: result.child.pid });
      return await result;
    } finally {
      // If PID binding failed while a child is running, do not clear the unknown
      // intent. The isolated job must reconcile that child before any rerun.
      if (!result?.child?.pid || result.child.exitCode !== null || result.child.signalCode)
        await recordIndependentWorkerSpawn(musicRenderReservation, { spawnId, finished: true });
    }
  };
  try {
    let job, plan, rawPlan, design, manifest, manifestPath, originalFile, sourceFile, decisionPath;
    let planBase, gainDb, expected;
    await stage('validate_inputs', async () => {
      job = await readJson(jobPath);
      if (job.schema_version !== 1) throw new Error('Unsupported job schema');
      if (hasIndependentMusicPackFields(job)) {
        record.source_policy = await validateIndependentMusicPackPolicy(job,
          { outputDirectory: output, operation: 'run_sound_job' });
        record.diagnostic_candidates_only = true;
      }
      if (job.purpose !== undefined && !['production', 'technical_diagnostic'].includes(job.purpose)) {
        throw new Error('purpose must be production or technical_diagnostic');
      }
      record.purpose = job.purpose ?? 'production';
      if (job.preview !== undefined && (!job.preview || typeof job.preview !== 'object' || Array.isArray(job.preview)
        || Object.keys(job.preview).some(key => key !== 'review_only')
        || (job.preview.review_only !== undefined && typeof job.preview.review_only !== 'boolean'))) {
        throw new Error('preview must be an object with an optional boolean review_only');
      }
      const base = path.dirname(jobPath);
      manifestPath = resolveInput(base, job.manifest, 'manifest');
      decisionPath = resolveInput(base, job.sound_decisions, 'sound_decisions');
      manifest = await readJson(manifestPath);
      if (manifest.schema_version !== 1 || manifest.timeline?.sample_rate !== 48000 || manifest.analysis_window
        || !Number.isSafeInteger(manifest.timeline.duration_samples) || manifest.timeline.duration_samples <= 0) {
        throw new Error('Job requires a prepared full-episode 48000 Hz manifest');
      }
      gainDb = job.original_gain_db ?? 0;
      if (typeof gainDb !== 'number' || !Number.isFinite(gainDb) || !Number.isFinite(10 ** (gainDb / 20))) {
        throw new Error('original_gain_db must produce a finite gain');
      }
      if (gainDb !== 0 && job.original_audio_state !== 'source_aligned_unprocessed') {
        throw new Error('Nonzero original_gain_db requires original_audio_state=source_aligned_unprocessed');
      }
      if (gainDb !== 0 && manifest.original_audio_processing) {
        throw new Error('Original audio already has processing provenance; supply the unprocessed source manifest');
      }
      sourceFile = resolveInput(path.dirname(manifestPath), manifest.source_video, 'source_video');
      originalFile = resolveInput(path.dirname(manifestPath), manifest.original_audio, 'original_audio');
      expected = job.expected_sha256 ?? {};
      const allowed = ['manifest', 'plan', 'sound_decisions', 'source_video', 'original_audio', 'assets'];
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)
        || Object.keys(expected).some(key => !allowed.includes(key))) throw new Error('Invalid expected_sha256 fields');
      const bind = async (label, file, wanted) => {
        const actual = await hashFile(file);
        if (wanted !== undefined && (!/^[a-f0-9]{64}$/i.test(wanted) || actual !== wanted.toLowerCase())) {
          throw new Error(`${label} SHA-256 mismatch`);
        }
        return { path: file, sha256: actual, expected_sha256_checked: wanted !== undefined };
      };
      record.inputs.job = await bind('job', jobPath);
      record.inputs.manifest = await bind('manifest', manifestPath, expected.manifest);
      record.inputs.sound_decisions = await bind('sound_decisions', decisionPath, expected.sound_decisions);
      record.inputs.original_audio = await bind('original_audio', originalFile, expected.original_audio);
      record.inputs.source_video = await bind('source_video', sourceFile, expected.source_video ?? manifest.source_sha256);
      if (record.inputs.source_video.sha256 !== manifest.source_sha256?.toLowerCase()) throw new Error('Source video SHA-256 mismatch');
      if (typeof job.plan === 'string') {
        const planPath = resolveInput(base, job.plan, 'plan');
        plan = await readJson(planPath); planBase = path.dirname(planPath);
        record.inputs.plan = await bind('plan', planPath, expected.plan);
      } else {
        if (!job.plan || typeof job.plan !== 'object' || Array.isArray(job.plan)) throw new Error('plan must be an object or file path');
        if (expected.plan !== undefined) throw new Error('expected_sha256.plan requires a plan file path');
        plan = structuredClone(job.plan); planBase = base;
        record.inputs.plan = { representation: 'inline_object_in_hashed_job' };
      }
      if (!Array.isArray(plan.assets)) throw new Error('plan.assets must be an array');
      rawPlan = structuredClone(plan);
      record.computed_plan_sha256 = hashCreativePlan(rawPlan);
      record.inputs.assets = Object.create(null);
      if (expected.assets !== undefined && (!expected.assets || typeof expected.assets !== 'object' || Array.isArray(expected.assets))) {
        throw new Error('expected_sha256.assets must map asset IDs to hashes');
      }
      const ids = new Set();
      for (const asset of plan.assets) {
        if (typeof asset.id !== 'string' || !asset.id || ids.has(asset.id)) throw new Error('Missing or duplicate asset id');
        ids.add(asset.id);
        asset.path = resolveInput(planBase, asset.path, 'asset path');
        record.inputs.assets[asset.id] = await bind(`assets.${asset.id}`, asset.path, expected.assets?.[asset.id] ?? asset.sha256);
        if (asset.sha256 !== undefined && (!/^[a-f0-9]{64}$/i.test(asset.sha256)
          || record.inputs.assets[asset.id].sha256 !== asset.sha256.toLowerCase())) {
          throw new Error(`assets.${asset.id} declared SHA-256 mismatch`);
        }
      }
      if (Object.keys(expected.assets ?? {}).some(id => !ids.has(id))) throw new Error('Expected asset hash refers to an unknown asset');
      design = await readJson(decisionPath);
    });
    const admission = await acquireProjectMusicRenderLock({ config: job, inputFiles: [jobPath],
      source: record.inputs.source_video, outputDirectory: output, policyPath, cwd,
      plan: rawPlan, assets: record.inputs.assets, durationSamples: manifest.timeline.duration_samples, jobBinding: record.inputs.job });
    if (admission?.passed === false) {
      record.cross_work_music = admission; record.status = admission.status; record.next_action = admission.next_action;
      record.render_calls = 0; record.previews_created = 0;
      return record;
    }
    musicRenderReservation = admission?.reservation ?? null;
    if (musicRenderReservation?.kind === 'independent_render_reservation') {
      record.music_render_reservation = { kind: musicRenderReservation.kind, job_id: musicRenderReservation.job_id,
        history_root: musicRenderReservation.history_root, recovered: admission.recovered ?? [] };
      musicRenderHeartbeat = startProjectMusicRenderHeartbeat(musicRenderReservation);
    }
    const crossWorkBegan = performance.now();
    const crossWork = admission?.cross_work_music ?? await enforceCrossWorkDominantMusic({
      config: job, plan: rawPlan, assets: record.inputs.assets, durationSamples: manifest.timeline.duration_samples,
      source: record.inputs.source_video, inputFiles: [jobPath], outputDirectory: output, policyPath, cwd });
    if (crossWork) {
      record.stages.push({ name: 'cross_work_dominant_music', status: 'completed',
        elapsed_seconds: (performance.now() - crossWorkBegan) / 1000 });
      record.cross_work_music = crossWork;
      if (!crossWork.passed) {
        record.status = crossWork.status; record.next_action = crossWork.next_action;
        record.render_calls = 0; record.previews_created = 0;
        return record;
      }
    }
    // Verify the independent creative contract before any source-supply
    // decision, so an invalid handoff is reported even when music is missing.
    // Both checks remain before media processing and rendering.
    if (design.craft_mode === 'fine' && record.purpose !== 'technical_diagnostic') {
      record.creative_handoff = await stage('validate_creative_handoff', () => validateCreativeHandoff({
        binding: job.creative_handoff, base: path.dirname(jobPath), sourceSha256: record.inputs.source_video.sha256,
        designSha256: record.inputs.sound_decisions.sha256, durationSeconds: manifest.timeline.duration_samples / 48000,
        design, plan: rawPlan, assets: record.inputs.assets,
      }));
    } else {
      record.creative_handoff = { status: record.purpose === 'technical_diagnostic'
        ? 'not_required_for_explicit_diagnostic' : 'not_required_for_non_fine_job',
      semantic_assessment: 'not_performed', artistic_acceptance: 'not_assessed' };
    }
    // A physical-effect-only job adds no BGM and cannot consume an auxiliary
    // music quota. Explicit provenance or an independent music policy is
    // still checked; every production job that actually adds music retains
    // the original 70% source floor.
    const addsMusic=rawPlan.cues.some(cue=>cue.track==='bgm');
    if ((record.purpose === 'production' && addsMusic) || job.music_source_provenance || hasIndependentMusicPackFields(job)) {
      record.music_source_budget = await stage('music_source_budget', () => enforceEpisodeMusicSourceBudget({
        config: job, plan, out: output, durationSamples: manifest.timeline.duration_samples }));
      if (!record.music_source_budget.passed) {
        record.status = hasIndependentMusicPackFields(job) ? 'independent_pack_source_gap' : 'reference_music_budget_gap';
        record.next_action = record.music_source_budget.next_action;
        return record;
      }
    }
    await stage('prepare_original_audio', async () => {
      const mediaDirectory = path.join(output, 'media');
      await mkdir(mediaDirectory);
      manifest.source_video = sourceFile;
      manifest.original_audio = originalFile;
      if (manifest.analysis_audio) manifest.analysis_audio = resolveInput(path.dirname(manifestPath), manifest.analysis_audio, 'analysis_audio');
      for (const frame of manifest.frames ?? []) frame.path = resolveInput(path.dirname(manifestPath), frame.path, 'frame path');
      if (gainDb !== 0) {
        const processed = path.join(mediaDirectory, 'original.wav');
        const parameters = ['-v', 'error', '-nostdin', '-n', '-i', originalFile, '-map', '0:a:0',
          '-ar', '48000', '-ac', '2', '-af', `volume=${gainDb}dB`, '-c:a', 'pcm_f32le', processed];
        try { await executeBoundWorker('ffmpeg', parameters, { windowsHide: true, maxBuffer: 1024 * 1024 }); }
        catch { throw new Error('Original audio gain processing failed'); }
        manifest.original_audio = processed;
        manifest.original_audio_processing = { operation: 'volume', gain_db: gainDb,
          input_path: originalFile, input_sha256: record.inputs.original_audio.sha256,
          source_manifest: manifestPath, source_manifest_sha256: record.inputs.manifest.sha256 };
        record.original_audio_processing = { ...manifest.original_audio_processing, parameters,
          declared_input_state: job.original_audio_state,
          output_sha256: await hashFile(processed), application_count: 1 };
      } else {
        record.original_audio_processing = { operation: 'reuse_source_without_scaling', gain_db: 0, application_count: 0,
          input_path: originalFile, input_sha256: record.inputs.original_audio.sha256,
          source_manifest: manifestPath, source_manifest_sha256: record.inputs.manifest.sha256,
          declared_input_state: job.original_audio_state ?? 'not_declared',
          inherited_processing: manifest.original_audio_processing ?? null,
          output_sha256: record.inputs.original_audio.sha256 };
      }
      await writeJson(path.join(mediaDirectory, 'manifest.json'), manifest);
      record.inputs.plan_manifest_before_override = plan.manifest ?? null;
      plan.manifest = path.join(mediaDirectory, 'manifest.json');
      if (hasIndependentMusicPackFields(job)) plan.independent_trial_context = {
        mode: job.mode, automatic_trial: job.automatic_trial, material_strategy: job.material_strategy,
        source_policy: job.source_policy, trial_review_policy: job.trial_review_policy,
        production_approval: false, purpose: record.purpose };
      await writeJson(path.join(output, 'plan.json'), plan);
      if (design.director_contract_version === 2) {
        for (const beat of design.story_beats ?? []) for (const ref of beat.evidence_refs ?? []) {
          if (ref && typeof ref.path === 'string' && ref.path.trim()) ref.path = path.resolve(path.dirname(decisionPath), ref.path);
        }
      }
      await writeJson(path.join(output, 'sound-decisions.json'), design);
    });
    const renderDirectory = path.join(output, 'render');
    await musicRenderHeartbeat?.check();
    const renderReport = await stage('render', () => renderPlan(path.join(output, 'plan.json'), renderDirectory,
      { policyPath, cwd,...(job.final_mix_master!==undefined?{finalMixMaster:job.final_mix_master}:{}),
        ...(job.sfx_audibility_repair!==undefined?{sfxAudibilityRepair:job.sfx_audibility_repair,
          soundDecisionsFile:path.join(output,'sound-decisions.json')} : {}),
        ...(job.render_decode_cache!==undefined?{renderDecodeCache:job.render_decode_cache,python:job.python}:{}) }));
    const effectivePlanFile=renderReport.sfx_audibility_repair?.applied_plan?.path??path.join(output,'plan.json');
    const coverage = await stage('check_sound_coverage', async () => {
      const parameters = [path.join(scriptDirectory, 'check_sound_design.mjs'), '--design', path.join(output, 'sound-decisions.json'),
        '--plan', effectivePlanFile, '--render', renderDirectory];
      let result;
      try { result = await executeBoundWorker(process.execPath, parameters, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); }
      catch (error) {
        if (error.code !== 2) throw new Error('Sound coverage checker failed');
        result = error;
      }
      const parsed = JSON.parse(result.stdout);
      await writeJson(path.join(output, 'sound-coverage.json'), parsed);
      return parsed;
    });
    for (const name of ['plan.json', 'media/manifest.json', 'sound-decisions.json', 'render/report.json', 'sound-coverage.json']) {
      record.outputs[name] = { path: name, sha256: await hashFile(path.join(output, name)) };
    }
    if(renderReport.sfx_audibility_repair){
      record.sfx_audibility_repair=renderReport.sfx_audibility_repair;
      record.outputs['sfx-audibility-repair.json']={path:path.relative(output,renderReport.sfx_audibility_repair.record.path),
        sha256:renderReport.sfx_audibility_repair.record.sha256};
      if(renderReport.sfx_audibility_repair.applied_plan){
        record.outputs['producer-plan.json']=record.outputs['plan.json'];
        record.outputs['plan.json']={path:path.relative(output,effectivePlanFile),sha256:await hashFile(effectivePlanFile)};
      }
    }
    for (const [track, sha256] of Object.entries(renderReport.output_sha256)) {
      record.outputs[track] = { path: `render/${track}.wav`, sha256 };
    }
    if(job.final_mix_master!==undefined){
      const checked=await verifyFinalMixMaster({planFile:effectivePlanFile,renderDirectory,
        report:await readJson(path.join(renderDirectory,'report.json')),expectedConfig:job.final_mix_master});
      if(checked.issues.length)throw Error('sound_job_final_mix_master_invalid:'+checked.issues.join(','));
      const masterFile=path.join(renderDirectory,'final-mix-master.json');
      record.final_mix_master={config:job.final_mix_master,record:{path:masterFile,sha256:await hashFile(masterFile)},
        status:checked.master.status,final_mix:checked.master.final_mix,production_approval:false};
      for(const name of ['final_mix.wav','final-mix-master.json'])
        record.outputs[name]={path:`render/${name}`,sha256:await hashFile(path.join(renderDirectory,name))};
      record.final_mix_master.raw_mix_status_retained=true;
    }
    record.mix_status = renderReport.status;
    record.mix_issues = renderReport.issues;
    record.coverage_status = coverage.status;
    record.status = coverage.status !== 'coverage_ready_for_audition' ? 'incomplete_sound_coverage'
      : renderReport.status !== 'technical_ok' ? 'needs_mix_review' : 'ready_for_audition';
    if (record.purpose === 'technical_diagnostic') {
      record.diagnostic_result = record.status;
      record.status = 'technical_diagnostic';
    }
    if (job.preview !== undefined) {
      const restrictedSource = job.preview.review_only === true && renderReport.status === 'needs_mix_review'
        && renderReport.issues?.length === 1 && renderReport.issues[0] === 'original_audio_kind_requires_review';
      const safeFinalBus=job.preview.review_only===true&&record.final_mix_master?.status==='technical_safe_final_bus';
      if (coverage.status !== 'coverage_ready_for_audition') {
        record.preview = { status: 'not_exported', reason: 'incomplete_sound_coverage' };
      } else if (renderReport.status !== 'technical_ok' && !restrictedSource&&!safeFinalBus) {
        record.preview = { status: 'not_exported', reason: 'mix_review_required', mix_issues: renderReport.issues };
      } else {
        await stage('export_preview', async () => {
          const preview = path.join(output, 'preview.mp4');
          const parameters = [path.join(scriptDirectory, 'export_preview.mjs'), effectivePlanFile,
            '--render', renderDirectory, '--out', preview];
          if (job.preview.review_only === true) parameters.push('--review-only');
          try { await executeBoundWorker(process.execPath, parameters, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }); }
          catch { throw new Error('Preview export failed; check its report and preserved render outputs'); }
          const previewReport = await readJson(`${preview}.json`);
          record.preview = { status: previewReport.status, encoded_technical_status: previewReport.encoded_technical_status,
            review_only: previewReport.review_only, production_approval: false, command: process.execPath, parameters };
          for (const name of ['preview.mp4', 'preview.mp4.json']) {
            record.outputs[name] = { path: name, sha256: await hashFile(path.join(output, name)) };
          }
        });
      }
    }
  } catch (error) {
    record.status = 'failed'; record.failure = errorMessage(error);
    throw error;
  } finally {
    record.elapsed_seconds = (performance.now() - started) / 1000;
    record.completed_at = new Date().toISOString();
    const completedRenderNeedsRegistration = record.cross_work_music?.passed
      && record.stages.some(row => row.name === 'render' && row.status === 'completed')
      && (musicRenderReservation?.kind !== 'independent_render_reservation' || record.status !== 'failed');
    let deliveryHistoryPersisted = false;
    try {
      await writeJson(path.join(output, 'run-record.json'), record);
      if (completedRenderNeedsRegistration) {
        await musicRenderHeartbeat?.check();
        record.music_usage_registration = await registerCompletedMusicDelivery({
          runRecordFile: path.join(output, 'run-record.json'), historyRoot: record.cross_work_music.history_root });
        deliveryHistoryPersisted = true;
        await writeJson(path.join(output, 'music-usage-registration.json'), record.music_usage_registration);
      }
    } finally {
      await musicRenderHeartbeat?.stop();
      if (!completedRenderNeedsRegistration || deliveryHistoryPersisted) await releaseProjectMusicRenderLock(musicRenderReservation,
        { receipt: record.music_usage_registration ?? null, failure: record.failure ?? record.status });
    }
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [job, flag, output, ...extra] = process.argv.slice(2);
  if (!job || flag !== '--out' || !output || extra.length) {
    console.error('Usage: node run_sound_job.mjs JOB.json --out NEW_EMPTY_DIRECTORY'); process.exitCode = 1;
  } else {
    runSoundJob(job, output).then(record => {
      console.log(`${record.status}; artistic acceptance not assessed; production approval false`);
      if (record.status === 'incomplete_sound_coverage' || record.cross_work_music?.passed === false) process.exitCode = 2;
    }).catch(error => { console.error(errorMessage(error)); process.exitCode = 1; });
  }
}
