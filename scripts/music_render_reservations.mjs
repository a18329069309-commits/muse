import path from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ACTIVE = new Set(['reserved', 'recovery_required']);
const fail = code => { throw Error(code); };
const json = value => JSON.stringify(value);
const execute = promisify(execFile);

// Lease expiry alone is never authority to evict a renderer. The owner must be
// positively dead on this host; a live/reused PID or remote owner remains held.
export function isDeadLocalRenderOwner(row) {
  if (row.owner_host !== hostname() || !Number.isSafeInteger(row.owner_pid) || row.owner_pid <= 0) return false;
  try { process.kill(row.owner_pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

// Windows retains a child's original parent PID after the parent exits. Confirm
// the process tree is gone before restarting work: a dead Node owner alone does
// not establish that its FFmpeg/preview subprocess has stopped.
export async function inspectDeadRenderProcessTree(row) {
  if (!isDeadLocalRenderOwner(row)) return { status: 'owner_not_confirmed_dead', descendants: [] };
  if ((row.worker_intents ?? []).some(worker => worker.state === 'starting'))
    return { status: 'descendant_status_unknown', descendants: [], reason: 'spawn_intent_without_durable_child_pid' };
  if (process.platform !== 'win32') return { status: 'descendant_status_unknown', descendants: [],
    reason: 'non_windows_orphan_reparenting_requires_worker_process_ledger' };
  try {
    const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    const processes = JSON.parse(result.stdout), rows = Array.isArray(processes) ? processes : [processes];
    const descendants = new Set(), parents = [row.owner_pid, ...(row.worker_intents ?? [])
      .filter(worker => Number.isSafeInteger(worker.pid) && worker.pid > 0).map(worker => worker.pid)];
    for (const workerPid of parents.slice(1)) if (rows.some(item => item.ProcessId === workerPid)) descendants.add(workerPid);
    for (let index = 0; index < parents.length; index += 1) {
      for (const child of rows.filter(item => item.ParentProcessId === parents[index])) {
        if (descendants.has(child.ProcessId)) continue;
        descendants.add(child.ProcessId); parents.push(child.ProcessId);
      }
    }
    return { status: descendants.size ? 'live_descendants' : 'clear', descendants: [...descendants] };
  } catch (error) { return { status: 'descendant_status_unknown', descendants: [], reason: error.code ?? 'process_query_failed' }; }
}

async function store(historyRoot) {
  if (!path.isAbsolute(historyRoot ?? '')) fail('cross_work_registry_absolute_paths_required');
  const directory = path.join(historyRoot, '.independent-admission');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'reservations.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS render_jobs (
      job_id TEXT PRIMARY KEY, state TEXT NOT NULL, owner_token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL, owner_host TEXT NOT NULL, lease_expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, identity_json TEXT NOT NULL, summary_json TEXT NOT NULL,
      output_directory TEXT NOT NULL, receipt_json TEXT, failure TEXT);
    CREATE TABLE IF NOT EXISTS render_job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL,
      at_ms INTEGER NOT NULL, event TEXT NOT NULL, owner_token TEXT NOT NULL, payload_json TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS render_worker_intents (
      spawn_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, owner_token TEXT NOT NULL,
      state TEXT NOT NULL, pid INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
  return { db, file };
}
const decode = row => row ? { ...row, identity: JSON.parse(row.identity_json), summary: JSON.parse(row.summary_json),
  receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null } : null;
const event = (db, row, name, payload, now = Date.now()) => db.prepare(
  'INSERT INTO render_job_events(job_id,at_ms,event,owner_token,payload_json) VALUES(?,?,?,?,?)')
  .run(row.job_id, now, name, row.owner_token, json(payload));
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function listIndependentRenderReservations(historyRoot) {
  const { db } = await store(historyRoot);
  try { return db.prepare('SELECT * FROM render_jobs ORDER BY updated_at,job_id').all().map(decode).map(row => ({ ...row,
    worker_intents: db.prepare('SELECT * FROM render_worker_intents WHERE job_id=? AND owner_token=?')
      .all(row.job_id, row.owner_token) })); }
  finally { db.close(); }
}

export async function recordIndependentWorkerSpawn(reservation, { spawnId = null, pid = null, finished = false } = {}) {
  const { db } = await store(reservation.history_root), now = Date.now();
  try {
    return transaction(db, () => {
      const row = decode(db.prepare('SELECT * FROM render_jobs WHERE job_id=?').get(reservation.job_id));
      if (!row || row.owner_token !== reservation.owner_token || !ACTIVE.has(row.state))
        fail('cross_work_render_reservation_owner_changed');
      if (!spawnId) {
        const id = randomUUID();
        db.prepare("INSERT INTO render_worker_intents(spawn_id,job_id,owner_token,state,pid,created_at,updated_at) VALUES(?,?,?,'starting',NULL,?,?)")
          .run(id, row.job_id, row.owner_token, now, now);
        return id;
      }
      const worker = db.prepare('SELECT * FROM render_worker_intents WHERE spawn_id=? AND owner_token=?').get(spawnId, row.owner_token);
      if (!worker) fail('cross_work_worker_spawn_identity_changed');
      if (!finished && (!Number.isSafeInteger(pid) || pid <= 0)) fail('cross_work_worker_pid_required');
      db.prepare('UPDATE render_worker_intents SET state=?,pid=?,updated_at=? WHERE spawn_id=?')
        .run(finished ? 'finished' : 'running', pid ?? worker.pid, now, spawnId);
      return spawnId;
    });
  } finally { db.close(); }
}

// Preparation and filesystem/audio verification happen before this synchronous
// transaction. No awaited work, decoding, network request or rendering holds it.
export async function reserveIndependentRender({ historyRoot, jobId, identity, summary, outputDirectory,
  completedHistory, compare, leaseMs = 120000 }) {
  if (!/^[a-f0-9]{64}$/.test(jobId ?? '') || !path.isAbsolute(outputDirectory ?? '')
    || typeof compare !== 'function' || !Number.isSafeInteger(leaseMs) || leaseMs < 1000)
    fail('cross_work_render_reservation_input_invalid');
  const { db, file } = await store(historyRoot), now = Date.now();
  try {
    return transaction(db, () => {
      const previous = decode(db.prepare('SELECT * FROM render_jobs WHERE job_id=?').get(jobId));
      if (previous && previous.identity_json !== json(identity)) fail('cross_work_render_job_identity_changed');
      if (previous?.state === 'completed') return { passed: false, status: 'cross_work_music_already_completed',
        job_id: jobId, existing_delivery: previous.receipt, existing_output_directory: previous.output_directory,
        next_action: 'reuse_existing_verified_delivery', render_calls: 0 };
      if (previous && ACTIVE.has(previous.state)) return { passed: false,
        status: isDeadLocalRenderOwner(previous) ? 'cross_work_music_recovery_required' : 'cross_work_music_render_busy',
        job_id: jobId, next_action: 'reconcile_existing_job_before_retry', render_calls: 0 };
      const rows = db.prepare("SELECT * FROM render_jobs WHERE state IN ('reserved','recovery_required','completed')").all().map(decode);
      const history = [...completedHistory, ...rows.filter(row => row.job_id !== jobId).map(row => ({ ...row.summary,
        reservation_job_id: row.job_id, reservation_state: row.state, delivered_at: new Date(row.updated_at).toISOString() }))];
      const comparison = compare(summary, history);
      if (!comparison.passed) return { ...comparison, passed: false, current: summary,
        next_action: 'revise_copied_arrangement_or_restore_work_identity', render_calls: 0 };
      const row = { job_id: jobId, owner_token: randomUUID(), owner_pid: process.pid, owner_host: hostname(),
        lease_expires_at: now + leaseMs, updated_at: now };
      if (previous) event(db, previous, 'retry_after_preserved_failure', { previous_state: previous.state,
        previous_output_directory: previous.output_directory, failure: previous.failure }, now);
      db.prepare(`INSERT INTO render_jobs(job_id,state,owner_token,owner_pid,owner_host,lease_expires_at,updated_at,
        identity_json,summary_json,output_directory,receipt_json,failure) VALUES(?,'reserved',?,?,?,?,?,?,?,?,NULL,NULL)
        ON CONFLICT(job_id) DO UPDATE SET state='reserved',owner_token=excluded.owner_token,owner_pid=excluded.owner_pid,
        owner_host=excluded.owner_host,lease_expires_at=excluded.lease_expires_at,updated_at=excluded.updated_at,
        output_directory=excluded.output_directory,receipt_json=NULL,failure=NULL`)
        .run(jobId, row.owner_token, row.owner_pid, row.owner_host, row.lease_expires_at, now,
          json(identity), json(summary), outputDirectory);
      event(db, row, 'reserved', { output_directory: outputDirectory, identity }, now);
      return { passed: true, comparison, reservation: { kind: 'independent_render_reservation', path: file,
        history_root: historyRoot, job_id: jobId, owner_token: row.owner_token, lease_ms: leaseMs }, history_root: historyRoot };
    });
  } finally { db.close(); }
}

export async function heartbeatIndependentRender(reservation) {
  const { db } = await store(reservation.history_root), now = Date.now();
  try {
    return transaction(db, () => {
      const row = decode(db.prepare('SELECT * FROM render_jobs WHERE job_id=?').get(reservation.job_id));
      if (!row || row.owner_token !== reservation.owner_token || !ACTIVE.has(row.state)
        || row.owner_pid !== process.pid || row.owner_host !== hostname()) fail('cross_work_render_reservation_owner_changed');
      db.prepare('UPDATE render_jobs SET updated_at=?,lease_expires_at=? WHERE job_id=?')
        .run(now, now + reservation.lease_ms, row.job_id);
      return true;
    });
  } finally { db.close(); }
}

export async function finishIndependentRender(reservation, { receipt = null, failure = null } = {}) {
  const { db } = await store(reservation.history_root), now = Date.now();
  try {
    return transaction(db, () => {
      const row = decode(db.prepare('SELECT * FROM render_jobs WHERE job_id=?').get(reservation.job_id));
      if (!row || row.owner_token !== reservation.owner_token) fail('cross_work_render_reservation_owner_changed');
      if (row.state === 'completed' && receipt && json(row.receipt) === json(receipt)) return row.receipt;
      if (!ACTIVE.has(row.state)) fail('cross_work_render_reservation_not_active');
      if (receipt && (!path.isAbsolute(receipt.path ?? '') || !/^[a-f0-9]{64}$/.test(receipt.sha256 ?? '')))
        fail('cross_work_render_delivery_binding_required');
      const unknownWorkers = db.prepare("SELECT spawn_id FROM render_worker_intents WHERE job_id=? AND owner_token=? AND state IN ('starting','running')")
        .all(row.job_id, row.owner_token);
      if (receipt && unknownWorkers.length) fail('cross_work_render_workers_not_finished');
      const state = receipt ? 'completed' : unknownWorkers.length ? 'recovery_required' : 'failed';
      db.prepare('UPDATE render_jobs SET state=?,updated_at=?,receipt_json=?,failure=? WHERE job_id=?')
        .run(state, now, receipt ? json(receipt) : null, failure ?? null, row.job_id);
      event(db, row, state, { receipt, failure }, now);
      return receipt;
    });
  } finally { db.close(); }
}

// Called only after the host has verified any preserved complete render. CAS on
// the old owner prevents recovery from overwriting a newly acquired reservation.
export async function recoverDeadIndependentRender(historyRoot, previous, { receipt = null, failure } = {}) {
  const { db } = await store(historyRoot), now = Date.now();
  try {
    return transaction(db, () => {
      const row = decode(db.prepare('SELECT * FROM render_jobs WHERE job_id=?').get(previous.job_id));
      if (!row || row.owner_token !== previous.owner_token || !ACTIVE.has(row.state)) return false;
      if (!isDeadLocalRenderOwner(row)) return false;
      const state = receipt ? 'completed' : 'failed';
      db.prepare('UPDATE render_jobs SET state=?,updated_at=?,receipt_json=?,failure=? WHERE job_id=?')
        .run(state, now, receipt ? json(receipt) : null, failure ?? 'dead_owner_without_verified_complete_render', row.job_id);
      event(db, row, receipt ? 'recovered_verified_delivery' : 'recovered_dead_owner_preserved_outputs',
        { receipt, failure, output_directory: row.output_directory }, now);
      return true;
    });
  } finally { db.close(); }
}

export async function holdIndependentRenderRecovery(historyRoot, previous, evidence) {
  const { db } = await store(historyRoot), now = Date.now();
  try {
    return transaction(db, () => {
      const row = decode(db.prepare('SELECT * FROM render_jobs WHERE job_id=?').get(previous.job_id));
      if (!row || row.owner_token !== previous.owner_token || !ACTIVE.has(row.state)) return false;
      db.prepare("UPDATE render_jobs SET state='recovery_required',failure=?,updated_at=? WHERE job_id=?")
        .run('render_subprocess_completion_not_confirmed', now, row.job_id);
      event(db, row, 'recovery_waiting_for_subprocesses', evidence, now);
      return true;
    });
  } finally { db.close(); }
}
