// Execute a missing exact window with existing offline CPU specialists, then expose real receipts.
import path from 'node:path';
import { mkdir, copyFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readJson, saveJson, shaBytes, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import {readGpuSingleSlotBinding,prepareGpuSingleSlotCommand,resolveGpuSingleSlotBinding} from './gpu_single_slot.mjs';
import { prepareSpecialistCandidateWindow } from './prepare_specialist_candidate_batch.mjs';
import { specialistRuntimeContentIdentity, legacySpecialistCandidates,
  resolveSpecialistCachedExecution,validSpecialistDevice,specialistModelEnvironment,
  specialistInferenceContracts } from './specialist_cache_identity.mjs';

const execute = promisify(execFile);
const bind = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const here = path.dirname(fileURLToPath(import.meta.url));
let cudaCommands=Promise.resolve();
const runDeviceCommand=(model,command,args,options,deadlineMs=null)=>{
  const invoke=()=>{
    const remaining=deadlineMs==null?Infinity:deadlineMs-Date.now();
    if(!(remaining>0))throw Error('specialist_batch_elapsed_budget_exhausted');
    return command(...args,{...options,timeout:Math.max(1,Math.min(options.timeout,remaining))});
  };
  if(model.device==='cpu')return invoke();
  const work=cudaCommands.then(invoke);
  cudaCommands=work.catch(()=>{});return work;
};

export async function createSpecialistWindowExecutor(config, runtime = {}) {
  if (!config?.python || !config.directory || config.model_configs?.length !== 2)
    throw new Error('explicit_specialist_execution_required');
  const templates = await Promise.all(config.model_configs.map(async file => {
    const binding = await bind(file), value = await readJson(file);
    if (!['qwen3_asr', 'panns_sed'].includes(value.backend) || !validSpecialistDevice(value.device))
      throw new Error('specialist_model_config_required');
    const { jobs, output_dir, array_dir, ...model } = value;
    return { binding, model };
  }));
  if (new Set(templates.map(row => row.model.backend)).size !== 2)
    throw new Error('both_specialists_required');
  if(templates.some(({model})=>!['cpu','cuda','cuda:0'].includes(model.device)))
    throw Error('gpu_slot_only_explicit_gpu_zero_supported');
  const runner = await bind(path.join(here, 'specialist_audio_observer.py'));
  const preparation = await bind(path.join(here, 'prepare_specialist_candidate_batch.mjs'));
  const script = await bind(fileURLToPath(import.meta.url));
  const cacheImplementation = await bind(path.join(here, 'specialist_cache_identity.mjs'));
  const gpuHelper=await bind(path.join(here,'gpu_single_slot.py'));
  const gpuAdapter=await bind(path.join(here,'gpu_single_slot.mjs'));
  const gpuSlot=templates.some(({model})=>model.device!=='cpu')
    ?resolveGpuSingleSlotBinding(config.gpu_slot,{...process.env,...config.environment}):undefined;
  if(gpuSlot)await readGpuSingleSlotBinding(gpuSlot);
  else if(templates.some(({model})=>model.device!=='cpu'))throw Error('gpu_slot_explicit_config_binding_required');
  const currentBindings = [runner, preparation, script, ...templates.map(row => row.binding), cacheImplementation,
    gpuHelper,gpuAdapter,...(gpuSlot?[gpuSlot]:[])];
  const executionKind = runtime.execute ? 'injected_test_executor' : 'local_subprocess';
  const actualAudioProcessed = executionKind === 'local_subprocess';
  const completedStatus = actualAudioProcessed ? 'completed_unqualified' : 'completed_test';
  const contentIdentity = specialistRuntimeContentIdentity({ bindings:currentBindings, python:config.python,
    executionKind, environment:config.environment,
    inferenceContracts:specialistInferenceContracts(templates,config.environment) });
  const revision = contentIdentity.revision;
  const snapshot = path.join(path.resolve(config.directory), '_runtime', revision);
  await mkdir(snapshot, { recursive: true });
  const bindings = [];
  for (const [index, source] of currentBindings.entries()) {
    const target = path.join(snapshot, source===gpuHelper?'gpu_single_slot.py':index + '-' + path.basename(source.path));
    try { await copyFile(source.path, target, constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const frozen = await bind(target);
    if (frozen.sha256 !== source.sha256) throw new Error('specialist_runtime_snapshot_changed');
    bindings.push(frozen);
  }
  const command = runtime.execute ?? execute, pending = new Map();
  const cachedExecution = (receiptFile,source,range) => resolveSpecialistCachedExecution({receiptFile,
    identity:contentIdentity, bindings:currentBindings, templates, source, range, executionKind,
    actualAudioProcessed, completedStatus,
    legacyCandidates:legacySpecialistCandidates({directory:config.directory, bindings:currentBindings,
      python:config.python, environment:config.environment, executionKind, source, range,
      locations:[here,...(config.cache_runtime_locations??[])]})});
  let queue = Promise.resolve();
  const run = async job => {
    if (!/^[a-f0-9]{64}$/.test(job.source_sha256 ?? '') || !Array.isArray(job.source_range)
      || job.source_range.length !== 2 || !job.source_range.every(Number.isFinite)
      || job.source_range[0] < 0 || job.source_range[1] <= job.source_range[0])
      throw new Error('specialist_window_input_identity_required');
    await verifyEvidenceBindings(currentBindings);
    await verifyEvidenceBindings(bindings);
    const source = { path: typeof job.source_file === 'string' ? job.source_file : job.source_file.path,
      sha256: job.source_sha256 };
    await verifyEvidenceBindings(source);
    const key = shaBytes(JSON.stringify([revision, source.sha256, job.source_range]));
    const directory = path.join(path.resolve(config.directory), key), receiptFile = path.join(directory, 'execution-record.json');
    const cached = await cachedExecution(receiptFile,source,job.source_range);
    if (cached) return cached;
    try { await readJson(path.join(directory, 'failure-record.json')); throw new Error('specialist_window_inference_failed_previous_attempt'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(directory, { recursive: true });
    let prepared, stage = 'preparation';
    const receipts = [], processes = [];
    try {
      prepared = await prepareSpecialistCandidateWindow({ id: 'window-' + key.slice(0, 24),
        source_file: source.path, source_sha256: source.sha256, source_window_seconds: job.source_range,
        segment_id: job.segment_id }, path.join(directory, 'inputs'), { ffmpeg: config.ffmpeg, command });
      for (const { model } of templates) {
        stage = model.backend;
        const output = path.join(directory, model.backend);
        const configFile = await saveJson(path.join(directory, model.backend + '-config.json'), { ...model,
          output_dir: output, ...(model.backend === 'panns_sed' ? { array_dir: path.join(directory, 'event-scores') } : {}),
          jobs: [prepared],...(model.device==='cpu'?{}:{gpu_slot:gpuSlot}) });
        const environment=specialistModelEnvironment(model,config.environment);
        const invocation=await prepareGpuSingleSlotCommand({python:config.python,script:bindings[0].path,
          args:['--config',configFile.path],device:model.device,slot:gpuSlot,
          helper:bindings[currentBindings.indexOf(gpuHelper)].path,environment});
        const result = await runDeviceCommand(model,command,[invocation.file,invocation.args], {
          windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: config.timeout_ms ?? 300000,
          env:environment });
        const receipt = await bind(path.join(output, 'receipt.json')), value = await readJson(receipt.path);
        if (value.status !== 'completed_unqualified' || value.device !== model.device || value.qualified !== false
          || value.backend !== model.backend || value.model_revision !== model.model_revision
          || value.model_sha256 !== model.model_sha256 || value.jobs?.length !== 1
          || value.jobs[0].id !== prepared.id || value.jobs[0].status !== 'predicted' || !(value.jobs[0].forward_calls > 0))
          throw new Error('specialist_window_inference_failed');
        receipts.push(receipt);
        processes.push({ configuration: configFile, backend: model.backend, exit_code: 0,
          stdout_sha256: shaBytes(result.stdout ?? ''), stderr_sha256: shaBytes(result.stderr ?? '') });
      }
      await verifyEvidenceBindings(currentBindings);
      await verifyEvidenceBindings(bindings);
      await verifyEvidenceBindings([source, { path: prepared.input_file, sha256: prepared.input_sha256 }]);
      const record = { schema_version: 1, status: completedStatus, execution_kind: executionKind, revision,
        runtime_content_identity:contentIdentity, source,
        source_range: job.source_range, input_audio: { path: prepared.input_file, sha256: prepared.input_sha256 },
        receipts, processes, bindings, actual_audio_processed: actualAudioProcessed, qualified: false,
        artistic_approval: false, production_approval: false, paid_calls: 0, uploads: 0, model_downloads: 0 };
      await saveJson(receiptFile, record);
      return { ...record, execution_record: await bind(receiptFile) };
    } catch (error) {
      let failedResult;
      if (stage !== 'preparation') {
        try { failedResult = await bind(path.join(directory, stage, 'receipt.json')); }
        catch (bindingError) { if (bindingError.code !== 'ENOENT') throw bindingError; }
      }
      await saveJson(path.join(directory, 'failure-record.json'), { schema_version: 1, status: 'failed',
        revision, execution_kind: executionKind, source, source_range: job.source_range, stage, error_type: error.name,
        partial_receipts: receipts, processes, ...(failedResult ? { failed_result: failedResult } : {}),
        ...(typeof error.stderr === 'string' ? { stderr_sha256: shaBytes(error.stderr) } : {}),
        inference_complete: false, qualified: false, production_approval: false });
      throw new Error('specialist_window_inference_failed');
    }
  };
  // Reuse the existing observer's jobs[] loop: one load per backend, still one
  // unchanged forward per window. No padded/tensor batch or reduced coverage.
  const runBatch = async (jobs, { deadlineMs } = {}) => {
    const rows = [], unique = new Map();
    for (const job of jobs) {
      const identity = JSON.stringify([job.source_sha256, job.source_range]);
      if (unique.has(identity)) {
        try { await verifyEvidenceBindings({ path: typeof job.source_file === 'string' ? job.source_file : job.source_file.path,
          sha256: job.source_sha256 }); rows.push(unique.get(identity)); }
        catch (error) { rows.push({ error }); }
        continue;
      }
      const row = { job }; rows.push(row); unique.set(identity, row);
      try {
        if (!/^[a-f0-9]{64}$/.test(job.source_sha256 ?? '') || !Array.isArray(job.source_range)
          || job.source_range.length !== 2 || !job.source_range.every(Number.isFinite)
          || job.source_range[0] < 0 || job.source_range[1] <= job.source_range[0])
          throw new Error('specialist_window_input_identity_required');
        await verifyEvidenceBindings([currentBindings, bindings]);
        row.source = { path: typeof job.source_file === 'string' ? job.source_file : job.source_file.path,
          sha256: job.source_sha256 };
        await verifyEvidenceBindings(row.source);
        row.key = shaBytes(JSON.stringify([revision, row.source.sha256, job.source_range]));
        row.directory = path.join(path.resolve(config.directory), row.key);
        row.receiptFile = path.join(row.directory, 'execution-record.json');
        const cached = await cachedExecution(row.receiptFile,row.source,row.job.source_range);
        if (cached) { row.value = cached; continue; }
        try { await readJson(path.join(row.directory, 'failure-record.json'));
          throw new Error('specialist_window_inference_failed_previous_attempt'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await mkdir(row.directory, { recursive: true });
        row.prepared = await prepareSpecialistCandidateWindow({ id: 'window-' + row.key.slice(0, 24),
          source_file: row.source.path, source_sha256: row.source.sha256, source_window_seconds: job.source_range,
          segment_id: job.segment_id }, path.join(row.directory, 'inputs'), { ffmpeg: config.ffmpeg, command });
        row.receipts = []; row.processes = [];
      } catch (error) { row.error = error; }
    }
    const prepared = [...unique.values()].filter(row => row.prepared && !row.error);
    const batchId = shaBytes(JSON.stringify([revision, prepared.map(row => row.key)]));
    const batchDirectory = path.join(path.resolve(config.directory), '_batches', batchId);
    if (prepared.length) await mkdir(batchDirectory, { recursive: true });
    for (const { model } of templates) {
      const active = prepared.filter(row => !row.error);
      if (!active.length) break;
      const output = path.join(batchDirectory, model.backend);
      const configFile = await saveJson(path.join(batchDirectory, model.backend + '-config.json'), { ...model,
        output_dir: output, ...(model.backend === 'panns_sed' ? { array_dir: path.join(batchDirectory, 'event-scores') } : {}),
        jobs: active.map(row => row.prepared),...(model.device==='cpu'?{}:{gpu_slot:gpuSlot}) });
      let receipt, value, processRecord;
      try {
        const remaining = deadlineMs == null ? Infinity : deadlineMs - Date.now();
        if (!(remaining > 0)) throw new Error('specialist_batch_elapsed_budget_exhausted');
        const environment=specialistModelEnvironment(model,config.environment);
        const invocation=await prepareGpuSingleSlotCommand({python:config.python,script:bindings[0].path,
          args:['--config',configFile.path],device:model.device,slot:gpuSlot,
          helper:bindings[currentBindings.indexOf(gpuHelper)].path,environment});
        const result = await runDeviceCommand(model,command,[invocation.file,invocation.args], {
          windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
          timeout: Math.max(1, Math.min((config.timeout_ms ?? 300000) * active.length, remaining)),
          env:environment },deadlineMs);
        receipt = await bind(path.join(output, 'receipt.json')); value = await readJson(receipt.path);
        if (value.status !== 'completed_unqualified' || value.device !== model.device || value.qualified !== false
          || value.backend !== model.backend || value.model_revision !== model.model_revision
          || value.model_sha256 !== model.model_sha256 || value.jobs?.length !== active.length
          || new Set(value.jobs.map(job => job.id)).size !== active.length
          || value.jobs.some(job => !active.some(row => row.prepared.id === job.id)))
          throw new Error('specialist_window_inference_failed');
        processRecord = { configuration: configFile, backend: model.backend, exit_code: 0,
          stdout_sha256: shaBytes(result.stdout ?? ''), stderr_sha256: shaBytes(result.stderr ?? '') };
      } catch (error) {
        for (const row of active) { row.error = error; row.stage = model.backend; }
        continue;
      }
      for (const row of active) {
        try {
          const job = value.jobs.find(item => item.id === row.prepared.id);
          if (job.status !== 'predicted' || !(job.forward_calls > 0)) throw new Error('specialist_window_inference_failed');
          const rawBinding = { path: job.raw_receipt, sha256: job.raw_sha256 };
          await verifyEvidenceBindings(rawBinding);
          const raw = await readJson(rawBinding.path);
          if (raw.status !== 'predicted' || raw.qualified !== false || raw.source_sha256 !== row.source.sha256
            || JSON.stringify(raw.source_window_seconds) !== JSON.stringify(row.job.source_range)
            || raw.input_sha256 !== row.prepared.input_sha256 || raw.forward_calls !== job.forward_calls)
            throw new Error('specialist_window_batch_raw_identity_changed');
          row.receipts.push(receipt); row.processes.push(processRecord);
        } catch (error) { row.error = error; row.stage = model.backend; }
      }
    }
    for (const row of prepared) {
      if (!row.error) try {
        await verifyEvidenceBindings([currentBindings, bindings, row.source,
          { path: row.prepared.input_file, sha256: row.prepared.input_sha256 }]);
        const record = { schema_version: 1, status: completedStatus, execution_kind: executionKind, revision,
          runtime_content_identity:contentIdentity,
          source: row.source, source_range: row.job.source_range,
          input_audio: { path: row.prepared.input_file, sha256: row.prepared.input_sha256 },
          receipts: row.receipts, processes: row.processes, bindings, actual_audio_processed: actualAudioProcessed,
          qualified: false, artistic_approval: false, production_approval: false, paid_calls: 0, uploads: 0, model_downloads: 0 };
        await saveJson(row.receiptFile, record);
        row.value = { ...record, execution_record: await bind(row.receiptFile) };
      } catch (error) { row.error = error; }
      if (row.error) await saveJson(path.join(row.directory, 'failure-record.json'), { schema_version: 1, status: 'failed',
        revision, execution_kind: executionKind, source: row.source, source_range: row.job.source_range,
        stage: row.stage ?? 'verification', error_type: row.error.name, error: row.error.message,
        partial_receipts: row.receipts, processes: row.processes,
        inference_complete: false, qualified: false, production_approval: false });
    }
    return rows.map(row => row.error ? { status: 'rejected', reason: row.error } : { status: 'fulfilled', value: row.value });
  };
  return { revision, bindings, verifyCurrent: () => verifyEvidenceBindings(currentBindings), executeBatch: (jobs, options = {}) => {
    if (!Array.isArray(jobs) || !jobs.length || jobs.length > 8) throw new Error('specialist_batch_requires_one_to_eight_windows');
    const work = queue.then(() => runBatch(jobs, options)); queue = work.catch(() => {}); return work;
  }, execute: job => {
    const key = JSON.stringify([job.source_sha256, job.source_range]);
    if (!pending.has(key)) {
      const work = queue.then(() => run(job)); queue = work.catch(() => {});
      pending.set(key, work); work.finally(() => pending.delete(key)).catch(() => {});
    }
    return pending.get(key);
  } };
}
