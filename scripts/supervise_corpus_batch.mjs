import { spawn } from 'node:child_process';
import { mkdir, open, readFile, readdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shaBytes } from './audio_api.mjs';
import { validateAuthenticationProbe } from './codex_cli_runtime.mjs';

const GiB = 1024 ** 3;
const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const read = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const optional = async file => { try { return await read(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const boundConfig = async file => { const bytes = await readFile(file); return {
  path: path.resolve(file), sha256: shaBytes(bytes), value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')),
}; };
const bindWorker = async file => {
  const config = await boundConfig(file);
  config.manifest_sha256 = shaBytes(await readFile(config.value.manifest_file));
  return config;
};

async function acquireLock(file) {
  const claimFile = file + '.claim', token = randomUUID();
  let claim;
  try { claim = await open(claimFile, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('supervisor_lock_acquisition_in_progress'); throw error; }
  await claim.writeFile(JSON.stringify({ pid: process.pid, token })); await claim.close();
  try {
    const previous = await optional(file);
    if (previous && alive(previous.pid)) throw new Error('supervisor_already_running');
    if (previous) await rename(file, file + `.stale-${token}.json`);
    const handle = await open(file, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, token, started_at: new Date().toISOString() })); await handle.close();
  } finally {
    if ((await optional(claimFile))?.token === token) await unlink(claimFile);
  }
  return async () => {
    const current = await optional(file);
    if (current?.token === token && current.pid === process.pid) await unlink(file);
  };
}

async function treeBytes(directory) {
  let bytes = 0;
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) bytes += await treeBytes(file);
    else if (item.isFile()) bytes += (await stat(file)).size;
  }
  return bytes;
}

async function storageReady(directory) {
  const volume = await statfs(directory);
  return volume.bavail * volume.bsize >= 2 * GiB && await treeBytes(directory) <= GiB;
}

async function launchBatch(configFile, { directory, onSpawn, requestSafeYield }) {
  await mkdir(directory, { recursive: true });
  const stdout = await open(path.join(directory, 'stdout.log'), 'wx');
  const stderr = await open(path.join(directory, 'stderr.log'), 'wx');
  try {
    const child = spawn(process.execPath, [path.join(here, 'run_corpus_batch.mjs'), configFile], {
      cwd: path.dirname(here), windowsHide: true, shell: false, stdio: ['ignore', stdout.fd, stderr.fd],
    });
    let closed = false;
    const done = new Promise(resolve => {
      let spawnFailed = false;
      child.on('error', () => { spawnFailed = true; });
      child.on('close', (exitCode, signal) => { closed = true; resolve({ exit_code: exitCode, signal, spawn_failed: spawnFailed }); });
    });
    if (child.pid) await onSpawn(child.pid);
    let yieldError;
    while (requestSafeYield && !closed && !yieldError) {
      try { await requestSafeYield(); } catch (error) { yieldError = error; }
      if (!closed) await Promise.race([done, sleep(30000)]);
    }
    const result = await done;
    if (yieldError) throw yieldError;
    return result;
  } finally { await stdout.close(); await stderr.close(); }
}

const unknownOutcome = state => /unknown/.test(`${state?.status ?? ''}:${state?.error ?? ''}`)
  || Object.values(state?.episodes ?? {}).some(row => /unknown/.test(`${row.status}:${row.error}`))
  || Object.values(state?.works ?? {}).some(row => /unknown/.test(`${row.status}:${row.error}`));
const readyPilot = state => state?.pilot?.status === 'pilot_ready' || state?.engineering_pilot?.status === 'engineering_pilot_ready';
const finished = state => state?.status === 'batch_finished_with_gaps' && readyPilot(state);
const naturallyDrained = state => state?.status === 'drained' && readyPilot(state);
const signalStopped = state => state?.drain_origin?.kind === 'signal';
const quota = state => /quota|account_quota_wait/.test(`${state?.status ?? ''}:${state?.error ?? ''}`);
const finishedStatus = 'available_queue_finished_with_gaps';
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

const contentReceipts = episode => [...(episode?.observation_receipts ?? []), ...(episode?.cli_receipts ?? []),
  ...Object.values(episode?.specialists ?? {}).flatMap(attempts => attempts.flatMap(attempt => attempt.receipt ? [attempt.receipt] : []))];

async function verifiedQuota(state) {
  const paused = [...Object.values(state.episodes ?? {}), ...Object.values(state.works ?? {})].filter(quota);
  if (!paused.length) return false;
  const hashes = [];
  for (const row of paused) {
    const evidence = (row.cli_receipts?.length ? row.cli_receipts : row.result?.rule_synthesis?.cli_receipts)?.at(-1);
    try {
      const bytes = await readFile(evidence.path), receipt = JSON.parse(bytes);
      if (shaBytes(bytes) !== evidence.sha256 || receipt.execution_kind !== 'codex_cli_inference'
        || receipt.status !== 'quota_exhausted' || receipt.process_terminated !== true
        || !['director', 'nuwa', 'material_task_planning', 'material_candidate_selection'].includes(receipt.stage)
        || row.source_sha256 && receipt.source_video_sha256 !== row.source_sha256) return false;
      const requestBytes = await readFile(receipt.request.path), request = JSON.parse(requestBytes);
      if (shaBytes(requestBytes) !== receipt.request.sha256 || shaBytes(canonical(request)) !== receipt.request_sha256
        || request.role !== receipt.stage || request.execution_kind !== receipt.execution_kind
        || request.source_video_sha256 !== receipt.source_video_sha256) return false;
      hashes.push(evidence.sha256);
    } catch { return false; }
  }
  return shaBytes(JSON.stringify(hashes.sort()));
}

export async function superviseCorpusBatch(config, runtime = {}) {
  const overrides = config.worker_runtime_overrides;
  if (overrides && (Object.keys(overrides).some(key => !['stop_request_file', 'authResumeEvidence'].includes(key))
    || overrides.stop_request_file !== undefined && !path.isAbsolute(overrides.stop_request_file)))
    throw new Error('supervisor_worker_overrides_invalid');
  const workerValue = (value, naturalAdvance = false) => ({ ...value,
    ...(config.safe_extension_yield === true || naturalAdvance ? { allow_snapshot_on_drained: true } : {}),
    ...(overrides?.stop_request_file ? { stop_request_file: overrides.stop_request_file } : {}),
    ...(overrides?.authResumeEvidence ? { cli: { ...value.cli, authResumeEvidence: overrides.authResumeEvidence } } : {}),
  });
  if (config.follow_pid !== undefined && (!Number.isInteger(config.follow_pid) || config.follow_pid <= 0))
    throw new Error('supervisor_follow_pid_invalid');
  const initial = await bindWorker(config.initial_config_file);
  if (config.extension_config_files && config.extension_config_file) throw new Error('supervisor_extension_configuration_ambiguous');
  const extensionFiles = config.extension_config_files ?? (config.extension_config_file ? [config.extension_config_file] : []);
  if (!Array.isArray(extensionFiles)) throw new Error('supervisor_extension_files_required');
  const extensions = await Promise.all(extensionFiles.map(bindWorker));
  if (new Set([initial, ...extensions].map(item => item.manifest_sha256)).size !== extensions.length + 1)
    throw new Error('supervisor_extension_manifest_repeated');
  if (initial.value.phase !== 'continuous' || extensions.some(item => item.value.phase !== 'all')) throw new Error('supervisor_phase_contract_invalid');
  const root = path.resolve(initial.value.checkpoint_root), permanent = path.resolve(initial.value.permanent_root);
  if (extensions.some(item => path.resolve(item.value.checkpoint_root) !== root || path.resolve(item.value.permanent_root) !== permanent))
    throw new Error('supervisor_extension_roots_changed');
  await mkdir(root, { recursive: true });
  const release = await acquireLock(path.join(root, 'supervisor.lock'));
  const binding = worker => ({ path: worker.path, sha256: worker.sha256, manifest_sha256: worker.manifest_sha256 });
  const identity = { initial: binding(initial), extensions: extensions.map(binding),
    ...(config.safe_extension_yield === true ? { safe_extension_yield: true } : {}),
    ...(overrides ? { worker_runtime_overrides: overrides } : {}),
    ...(config.extension_queue_file ? { extension_queue_file: path.resolve(config.extension_queue_file) } : {}) };
  if (config.recovery_namespace !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/.test(config.recovery_namespace))
    throw new Error('supervisor_recovery_namespace_invalid');
  const stateFile = path.join(root, config.recovery_namespace ? `supervisor-state-${config.recovery_namespace}.json` : 'supervisor-state.json');
  const batchFile = path.join(root, 'batch-state.json');
  const now = runtime.now ?? Date.now, wait = runtime.sleep ?? sleep, processAlive = runtime.isProcessAlive ?? alive;
  let state;
  const save = async () => {
    state.complete_corpus_claimed = false; state.qualification_granted = false;
    state.updated_at = new Date(now()).toISOString();
    await writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2) + '\n'); await rename(stateFile + '.tmp', stateFile);
  };
  const stop = async (status, reason = null) => { state.status = status; state.reason = reason; await save(); return state; };
  const activeBatch = runtime.activeBatchPid ?? (async () => {
    if (config.follow_pid && !state.follow_pid_finished) {
      if (processAlive(config.follow_pid)) return config.follow_pid;
      state.follow_pid_finished = true;
    }
    if (state.followed_pid && processAlive(state.followed_pid)) return state.followed_pid;
    const pending = state.runs.at(-1);
    if (pending?.pid && !pending.completed_at && processAlive(pending.pid)) return pending.pid;
    const lock = await optional(path.join(root, 'batch.lock'));
    return lock?.pid && processAlive(lock.pid) ? lock.pid : null;
  });
  const batchState = runtime.readBatchState ?? (() => optional(batchFile));
  const checkStorage = runtime.storageReady ?? (() => storageReady(root));
  const run = runtime.runBatch ?? launchBatch;
  const staticCount = extensions.length;
  const refreshExtensions = async () => {
    if (!config.extension_queue_file) return true;
    const queue = await boundConfig(config.extension_queue_file), doc = queue.value;
    if (doc.schema_version !== 1 || doc.kind !== 'verified_batch_extension_queue' || !Array.isArray(doc.entries)
      || typeof doc.closed !== 'boolean') throw new Error('extension_queue_contract_invalid');
    const prior = state.extension_queue?.entries ?? [], accepted = [];
    if (doc.entries.length < prior.length) throw new Error('extension_queue_prior_entry_changed');
    let previousHash = (extensions[staticCount - 1] ?? initial).manifest_sha256;
    const hashes = new Set([initial, ...extensions.slice(0, staticCount)].map(row => row.manifest_sha256));
    for (const [index, entry] of doc.entries.entries()) {
      if (!entry.config?.path || !entry.manifest?.path || !entry.extension_receipt?.path
        || prior[index] && canonical(prior[index]) !== canonical(entry)) throw new Error('extension_queue_prior_entry_changed');
      const worker = await bindWorker(entry.config.path), receipt = await boundConfig(entry.extension_receipt.path);
      if (worker.sha256 !== entry.config.sha256 || worker.manifest_sha256 !== entry.manifest.sha256
        || path.resolve(worker.value.manifest_file) !== path.resolve(entry.manifest.path)
        || receipt.sha256 !== entry.extension_receipt.sha256 || worker.value.phase !== 'all'
        || path.resolve(worker.value.snapshot_extension_file ?? '') !== receipt.path
        || path.resolve(worker.value.checkpoint_root) !== root || path.resolve(worker.value.permanent_root) !== permanent)
        throw new Error('extension_queue_binding_changed');
      if (receipt.value.schema_version !== 1 || receipt.value.kind !== 'append_only_corpus_extension'
        || receipt.value.old?.media?.sha256 !== previousHash
        || receipt.value.next?.media?.sha256 !== worker.manifest_sha256 || hashes.has(worker.manifest_sha256)
        || !worker.value.candidate_manifest
        || shaBytes(await readFile(worker.value.candidate_manifest)) !== receipt.value.next?.candidates?.sha256)
        throw new Error('extension_queue_chain_invalid');
      previousHash = worker.manifest_sha256; hashes.add(previousHash); accepted.push(worker);
    }
    extensions.splice(staticCount, extensions.length - staticCount, ...accepted);
    if (state.extension_queue?.sha256 !== queue.sha256) {
      state.extension_queue = { path: queue.path, sha256: queue.sha256, entries: doc.entries, closed: doc.closed };
      await save();
    }
    return doc.closed;
  };
  const nextExtension = () => extensions[state.stage === 'initial' ? 0 : state.extension_index + 1];
  const requestSafeYield = async (selected, attempt, baseline) => {
    if (config.safe_extension_yield !== true) return;
    await refreshExtensions();
    const next = nextExtension(); if (!next) return;
    const current = await batchState();
    // Preflight and append admission are not content progress. Old successful receipts do not qualify.
    if (current?.status !== 'running' || current.identity?.manifest_sha256 !== selected.manifest_sha256
      || current.run_invocations?.at(-1)?.pid !== attempt.pid
      || !Object.entries(current.episodes ?? {}).some(([id, episode]) =>
        contentReceipts(episode).some(receipt => !baseline.get(id)?.has(canonical(receipt))))) return;
    const file = workerValue(selected.value).stop_request_file ?? path.join(root, 'stop-request.json');
    if (await optional(file)) return;
    await mkdir(path.dirname(file), { recursive: true });
    const marker = { schema_version: 1, kind: 'verified_extension_safe_yield',
      from_manifest_sha256: selected.manifest_sha256, next_config: binding(next),
      requested_at: new Date(now()).toISOString(), qualification_granted: false };
    try { await writeFile(file, JSON.stringify(marker, null, 2) + '\n', { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  };
  const advanceSafeYield = async (batch, selected) => {
    if (config.safe_extension_yield !== true || batch?.status !== 'drained') return false;
    const file = workerValue(selected.value).stop_request_file ?? path.join(root, 'stop-request.json'), marker = await optional(file);
    if (marker?.kind !== 'verified_extension_safe_yield') return false;
    const next = nextExtension();
    if (!next || marker.from_manifest_sha256 !== batch.identity?.manifest_sha256
      || marker.from_manifest_sha256 !== selected.manifest_sha256 || canonical(marker.next_config) !== canonical(binding(next)))
      throw new Error('safe_extension_yield_binding_changed');
    if (await activeBatch()) return false;
    const archive = file + `.consumed-${randomUUID()}.json`; await rename(file, archive);
    (state.safe_extension_yields ??= []).push({ stop_marker: archive, from_manifest_sha256: selected.manifest_sha256,
      next_config: binding(next), closed_at: new Date(now()).toISOString(), prior_pending_preserved: true });
    state.extension_index = state.stage === 'initial' ? 0 : state.extension_index + 1;
    state.stage = 'extension'; state.status = 'extension_ready'; state.quota_attempt = 0; await save();
    return true;
  };
  try {
    state = await optional(stateFile) ?? { schema_version: 1, identity, stage: 'initial', status: 'created', runs: [], quota_waits: [], storage_waits: 0 };
    if (JSON.stringify(state.identity) !== JSON.stringify(identity)) throw new Error('supervisor_configuration_changed');
    if (!state.run_log_namespace) {
      state.run_log_namespace = `${shaBytes(canonical(identity)).slice(0, 12)}-${randomUUID()}`;
      await save();
    }
    if (!/^[a-f0-9]{12}-[a-f0-9-]{36}$/.test(state.run_log_namespace)) throw new Error('supervisor_log_namespace_invalid');
    if (state.status === 'needs_attention') return state;
    if (state.status === finishedStatus && !config.extension_queue_file) return state;
    while (true) {
      const queueClosed = await refreshExtensions();
      const active = await activeBatch();
      if (active) {
        if (state.status !== 'following_active_batch' || state.followed_pid !== active) {
          state.status = 'following_active_batch'; state.followed_pid = active; await save();
        }
        await wait(30000); continue;
      }
      state.followed_pid = null;
      const batch = await batchState();
      const selected = state.stage === 'extension' ? extensions[state.extension_index] : initial;
      const naturalAdvance = state.natural_extension_drains?.some(row => canonical(row.next_config) === canonical(binding(selected)));
      const selectedValue = workerValue(selected.value, naturalAdvance);
      if (batch?.status === 'authorization_paused') {
        if (!selectedValue.cli?.authResumeEvidence) return await stop('waiting_for_authorization', 'explicit_authentication_probe_required');
        await validateAuthenticationProbe(selectedValue.cli.authResumeEvidence);
      }
      if (batch?.status === 'needs_attention') return await stop('needs_attention', batch.error ?? 'batch_needs_attention');
      if (unknownOutcome(batch)) return await stop('needs_attention', 'batch_outcome_unknown');
      if (signalStopped(batch) && config.resume_drained !== true)
        return await stop('waiting_for_resume', 'worker_interrupted');
      if (await advanceSafeYield(batch, selected)) continue;
      const yielded = state.safe_extension_yields?.at(-1);
      const verifiedYieldReady = config.safe_extension_yield === true && state.stage === 'extension'
        && yielded?.from_manifest_sha256 === batch?.identity?.manifest_sha256
        && canonical(yielded.next_config) === canonical(binding(selected));
      const naturalDrain = state.natural_extension_drains?.at(-1);
      const verifiedDrainReady = state.stage === 'extension'
        && naturalDrain?.from_manifest_sha256 === batch?.identity?.manifest_sha256
        && canonical(naturalDrain.next_config) === canonical(binding(selected));
      const stopFile = selectedValue.stop_request_file ?? path.join(root, 'stop-request.json');
      if (await optional(stopFile))
        return await stop('waiting_for_resume', 'batch_drained_or_stop_requested');
      if (batch?.status === 'drained' && state.runs.at(-1)?.signal && config.resume_drained !== true)
        return await stop('waiting_for_resume', 'worker_interrupted');
      const naturalTerminal = naturallyDrained(batch) && config.resume_drained !== true;
      if (naturalTerminal && batch.identity?.manifest_sha256 !== selected.manifest_sha256 && !verifiedDrainReady && !verifiedYieldReady)
        return await stop('needs_attention', 'completed_batch_manifest_mismatch');
      if (batch?.status === 'drained' && config.resume_drained !== true && !naturalTerminal && !verifiedYieldReady && !verifiedDrainReady)
        return await stop('waiting_for_resume', 'batch_drained_or_stop_requested');
      if ((finished(batch) || naturalTerminal) && batch.identity?.manifest_sha256 === selected.manifest_sha256) {
        const next = state.stage === 'initial' ? 0 : state.extension_index + 1;
        if (extensions[next]) {
          if (naturalTerminal) (state.natural_extension_drains ??= []).push({ from_manifest_sha256: selected.manifest_sha256,
            next_config: binding(extensions[next]), closed_at: new Date(now()).toISOString(), prior_pending_preserved: true });
          state.stage = 'extension'; state.extension_index = next; state.status = 'extension_ready'; state.quota_attempt = 0; await save();
          continue;
        }
        if (!queueClosed) {
          state.status = 'waiting_for_verified_extension'; await save();
          await wait(30000); continue;
        }
        return await stop(finishedStatus);
      }
      const previous = state.extension_index > 0 ? extensions[state.extension_index - 1] : initial;
      if (finished(batch) && !(state.stage === 'extension' && batch.identity?.manifest_sha256 === previous.manifest_sha256))
        return await stop('needs_attention', 'completed_batch_manifest_mismatch');
      if (batch?.status === 'running' && !state.runs.at(-1)?.completed_at)
        return await stop('needs_attention', 'batch_owner_exited_without_terminal_state');
      const attempted = state.runs.some(row => row.stage === state.stage && row.extension_index === state.extension_index);
      if (batch?.status === 'pilot_incomplete' && (attempted || !(selected.value.recovery_operations?.length)))
        return await stop('needs_attention', 'pilot_incomplete');
      if (quota(batch)) {
        if (selected.value.cli?.resumeAccountWait !== true) return await stop('needs_attention', 'account_wait_resume_not_enabled');
        const quotaProof = await verifiedQuota(batch);
        if (!quotaProof) return await stop('needs_attention', 'quota_evidence_invalid');
        if (!state.wait_until) {
          if (state.last_quota_proof === quotaProof) return await stop('needs_attention', 'quota_retry_without_new_receipt');
          state.last_quota_proof = quotaProof;
          const minutes = [30, 60, 120][Math.min(state.quota_attempt ?? 0, 2)];
          state.quota_attempt = (state.quota_attempt ?? 0) + 1; state.wait_until = now() + minutes * 60000;
          state.quota_waits.push({ minutes, until: new Date(state.wait_until).toISOString() }); state.status = 'quota_wait'; await save();
        }
        while (now() < state.wait_until) {
          if (await optional(stopFile)) return await stop('waiting_for_resume', 'stop_requested_during_account_wait');
          await wait(Math.min(30000, state.wait_until - now()));
        }
        state.wait_until = null;
      } else state.quota_attempt = 0;
      while (!await checkStorage()) {
        state.status = 'storage_wait'; state.storage_waits++; await save();
        if (await optional(stopFile)) return await stop('waiting_for_resume', 'stop_requested_during_storage_wait');
        await wait(30000);
      }
      if (await activeBatch()) continue;
      const current = await bindWorker(selected.path);
      if (current.sha256 !== selected.sha256 || current.manifest_sha256 !== selected.manifest_sha256)
        return await stop('needs_attention', 'worker_configuration_changed');
      const attempt = { stage: state.stage, ...(state.stage === 'extension' ? { extension_index: state.extension_index } : {}),
        config: { path: selected.path, sha256: selected.sha256 }, started_at: new Date(now()).toISOString(),
        log_directory: path.join(root, 'supervisor-runs', state.run_log_namespace, String(state.runs.length + 1)) };
      state.runs.push(attempt); state.status = 'launching'; await save();
      const yieldBaseline = new Map(Object.entries((await batchState())?.episodes ?? {}).map(([id, episode]) =>
        [id, new Set(contentReceipts(episode).map(canonical))]));
      let executionFile = selected.path;
      if (overrides || config.safe_extension_yield === true || naturalAdvance) {
        await mkdir(attempt.log_directory, { recursive: true });
        executionFile = path.join(attempt.log_directory, 'worker-config.json');
        await writeFile(executionFile, JSON.stringify(selectedValue, null, 2) + '\n', { flag: 'wx' });
        attempt.execution_config = { path: executionFile, sha256: shaBytes(await readFile(executionFile)) };
        await save();
      }
      const outcome = await run(executionFile, { directory: attempt.log_directory,
        requestSafeYield: () => requestSafeYield(selected, attempt, yieldBaseline),
        onSpawn: async pid => { attempt.pid = pid; state.status = 'worker_running'; await save(); } });
      Object.assign(attempt, outcome, { completed_at: new Date(now()).toISOString() });
      const result = await batchState(); attempt.batch_status = result?.status ?? null; await save();
      if (result?.status === 'authorization_paused') return await stop('waiting_for_authorization', 'explicit_authentication_probe_required');
      if (await activeBatch()) continue;
      if (result?.status === 'needs_attention') return await stop('needs_attention', result.error ?? 'batch_needs_attention');
      if (unknownOutcome(result)) return await stop('needs_attention', 'batch_outcome_unknown');
      if (result?.status === 'drained') {
        if (signalStopped(result) || outcome.signal) return await stop('waiting_for_resume', 'worker_interrupted');
        if (await advanceSafeYield(result, selected)) continue;
        if (await optional(stopFile)) return await stop('waiting_for_resume', 'batch_drained_or_stop_requested');
        if (outcome.exit_code !== 0 || outcome.spawn_failed) return await stop('needs_attention', 'worker_technical_failure');
        if (naturallyDrained(result) && config.resume_drained !== true) {
          if (result.identity?.manifest_sha256 !== selected.manifest_sha256)
            return await stop('needs_attention', 'completed_batch_manifest_mismatch');
          continue;
        }
        return await stop('waiting_for_resume', 'batch_drained');
      }
      if (outcome.exit_code !== 0 || outcome.spawn_failed) return await stop('needs_attention', 'worker_technical_failure');
      if (finished(result) && result.identity?.manifest_sha256 !== selected.manifest_sha256)
        return await stop('needs_attention', 'completed_batch_manifest_mismatch');
      if (!finished(result) && !quota(result) && result?.status !== 'storage_paused')
        return await stop('needs_attention', result?.status === 'pilot_incomplete' ? 'pilot_incomplete' : 'worker_technical_failure');
    }
  } catch (error) {
    if (state && JSON.stringify(state.identity) === JSON.stringify(identity)) {
      state.status = 'needs_attention'; state.reason = /^[a-z0-9_]+$/.test(error.message ?? '') ? error.message : 'supervisor_technical_failure'; await save();
    }
    throw error;
  } finally { await release(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const state = await superviseCorpusBatch(await read(process.argv[2]));
  process.stdout.write(JSON.stringify({ status: state.status, reason: state.reason ?? null, runs: state.runs.length }) + '\n');
  if (state.status === 'needs_attention') process.exitCode = 2;
}
