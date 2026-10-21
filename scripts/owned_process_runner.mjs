import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

const helper = fileURLToPath(new URL('./owned_process_tree.py', import.meta.url));
export function ownedProcessCommand(command, args, { python = process.env.SDR_PYTHON, tree = true, platform = process.platform } = {}) {
  if (platform !== 'win32' || !tree) return { command, args, treeOwned: false };
  if (typeof python !== 'string' || !path.isAbsolute(python) || !existsSync(python) || !statSync(python).isFile())
    throw Error('owned_process_tree_explicit_python_required');
  if(!existsSync(helper)||!statSync(helper).isFile())throw Error('owned_process_tree_helper_missing');
  return { command: python, args: ['-B', '-X', 'utf8', helper, '--', command, ...args], treeOwned: true };
}

// execFile-compatible bounded local execution. Both the queue and target share
// one absolute deadline; Windows owns the target tree before it can execute.
export async function execOwnedFile(command, args = [], options = {}) {
  const { deadlineAtMs = null, timeout = null, python, maxBuffer = 4 * 1024 * 1024,
    encoding = 'utf8', ...spawnOptions } = options;
  if (deadlineAtMs !== null && (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0))
    throw Error('owned_process_deadline_invalid');
  const remaining = deadlineAtMs === null ? Infinity : deadlineAtMs - Date.now();
  if (remaining <= 0) throw Object.assign(Error('owned_process_deadline_exhausted'), {
    code: 'owned_process_deadline_exhausted', child_started: false, terminated: true });
  const timeoutMs = Math.min(timeout ?? Infinity, remaining);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(Math.floor(timeoutMs)))
    throw Error('owned_process_timeout_required');
  const launch = ownedProcessCommand(command, args, { python });
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...spawnOptions.env,
      ...(deadlineAtMs === null ? {} : { SDR_EPISODE_DEADLINE_AT_MS: String(deadlineAtMs) }) };
    const child = spawn(launch.command, launch.args, { ...spawnOptions, env, windowsHide: true,
      shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0, timedOut = false, overflow = false, spawnError = null;
    const stdout = [], stderr = [];
    const collect = target => chunk => { bytes += chunk.length; target.push(chunk);
      if (bytes > maxBuffer && !overflow) { overflow = true; child.kill('SIGKILL'); } };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', error => { spawnError = error; }); child.stdin.on('error', () => {}); child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1, Math.floor(timeoutMs)));
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (launch.treeOwned && exitCode === 124 && deadlineAtMs !== null && Date.now() >= deadlineAtMs) timedOut = true;
      const decode = chunks => encoding === null || encoding === 'buffer' ? Buffer.concat(chunks) : Buffer.concat(chunks).toString(encoding);
      const result = { stdout: decode(stdout), stderr: decode(stderr), exitCode, signal, terminated: true,
        timedOut, killed: timedOut || overflow, process_tree_owned: launch.treeOwned };
      if (spawnError || timedOut || overflow || exitCode !== 0) return reject(Object.assign(
        Error(spawnError?.message ?? (timedOut ? 'owned_process_timeout' : overflow ? 'owned_process_max_buffer' : 'owned_process_failed')),
        result, { code: spawnError?.code ?? (timedOut ? 'owned_process_timeout' : overflow ? 'owned_process_max_buffer' : exitCode),
          child_started: !spawnError }));
      resolve(result);
    });
  });
}

// Isolate a complete existing renderer, including JS mixing and nested ffmpeg
// workers, under the same job. No production callback is serialized or replaced.
export async function runOwnedEpisodeTask(operation, args, { outputDirectory, trialBudget, python = process.env.SDR_PYTHON } = {}) {
  if (!['render_research_trial', 'run_sound_job'].includes(operation) || !path.isAbsolute(outputDirectory ?? ''))
    throw Error('owned_episode_task_invalid');
  const budget = await trialBudget.inspectLocal({ stage: `${operation}_worker_admission`, useRenderReserve: true });
  if (!Number.isSafeInteger(budget.deadline_at_ms)) throw Error('owned_episode_task_absolute_deadline_required');
  const parent = path.dirname(outputDirectory), id = randomUUID(), prefix = path.join(parent, `.owned-task-${id}`);
  await mkdir(parent, { recursive: true });
  const request = `${prefix}.request.json`, result = `${prefix}.result.json`, processReceipt = `${prefix}.process.json`;
  await writeFile(request, JSON.stringify({ schema_version: 1, operation, args, result,
    deadline_at_ms: budget.deadline_at_ms, qualified: false, production_approval: false }) + '\n', { flag: 'wx' });
  try {
    const execution = await execOwnedFile(process.execPath, [fileURLToPath(new URL('./episode_local_task_worker.mjs', import.meta.url)), request],
      { python, deadlineAtMs: budget.deadline_at_ms, timeout: Math.max(1, Math.ceil(budget.remaining_ms)),
        maxBuffer: 4 * 1024 * 1024, env: { ...process.env, ...(python ? { SDR_PYTHON: python } : {}) } });
    await writeFile(processReceipt, JSON.stringify({ ...execution, request, result, deadline_at_ms: budget.deadline_at_ms,
      operation, qualified: false, production_approval: false }) + '\n', { flag: 'wx' });
    await trialBudget.inspectLocal({ stage: `${operation}_worker_result_io`, useRenderReserve: true });
    const value = JSON.parse(await readFile(result, 'utf8'));
    const bind = async file => ({ path: file, sha256: createHash('sha256').update(await readFile(file)).digest('hex') });
    const evidence = { revision: 'owned-episode-local-task-v1', operation, deadline_at_ms: budget.deadline_at_ms,
      request: await bind(request), process_receipt: await bind(processReceipt), result: await bind(result),
      kernel_io_cancellation_scope: 'isolated_renderer_process_tree', account_calls: 0, qualification_granted: false };
    await writeFile(path.join(outputDirectory, 'owned-process-execution.json'), JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' });
    value.owned_process_execution = evidence;
    await trialBudget.inspectLocal({ stage: `${operation}_worker_result_read_complete`, useRenderReserve: true });
    return value;
  } catch (error) {
    try { await writeFile(processReceipt, JSON.stringify({ operation, request, result,
      code: error.code ?? error.message, terminated: error.terminated ?? null, stdout: error.stdout ?? '', stderr: error.stderr ?? '',
      deadline_at_ms: budget.deadline_at_ms, qualified: false, production_approval: false }) + '\n', { flag: 'wx' }); }
    catch (failure) { if (failure.code !== 'EEXIST') error.evidence_error = failure.code ?? failure.message; }
    await trialBudget.inspectLocal({ stage: `${operation}_worker_failure`, useRenderReserve: true });
    error.process_receipt_file = processReceipt; throw error;
  }
}
