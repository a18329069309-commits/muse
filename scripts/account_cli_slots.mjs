import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// All account callers must share this directory. Old callers must drain before
// enabling it. A dead owner does not prove that its Codex child has terminated.
export function createAccountCliSchedule({ directory, pollMs = 250, now = Date.now, sleep = delay } = {}) {
  if (!directory || !Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('account_cli_slots_configuration_invalid');
  const root = path.resolve(directory);
  const slots = [1, 2].map(number => path.join(root, `slot-${number}.json`));
  const attentionFile = path.join(root, 'needs-attention.json');
  let blockedError = null;

  function checkDeadline({ deadlineAtMs, queuedAtMs } = {}) {
    if (deadlineAtMs === undefined || deadlineAtMs === null) return;
    if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs <= 0) throw Error('account_cli_wait_deadline_invalid');
    if (now() < deadlineAtMs) return;
    const error = new Error('account_cli_wait_deadline_exhausted');
    error.code = error.message; error.status = 'waiting_deadline_exhausted';
    error.deadline_at_ms = deadlineAtMs; error.queue_wait_ms = Math.max(0, now() - queuedAtMs);
    error.child_started = false; throw error;
  }
  async function waitForSlot(options) {
    checkDeadline(options);
    await sleep(options.deadlineAtMs == null ? pollMs : Math.min(pollMs, options.deadlineAtMs - now()));
  }

  async function attention(reason, slot, owner = null) {
    const error = new Error('account_cli_slots_needs_attention');
    error.code = error.message; error.status = 'needs_attention'; blockedError = error;
    const receipt = path.join(root, `needs-attention-${randomUUID()}.json`);
    const document = { schema_version: 1, status: 'needs_attention', reason,
      slot, observer_pid: process.pid, owner, recorded_at: new Date().toISOString(),
      automatic_reclaim_performed: false };
    try {
      await writeFile(receipt, JSON.stringify(document) + '\n', { flag: 'wx' }); error.receipt_file = receipt;
      try { await writeFile(attentionFile, JSON.stringify({ ...document, receipt_file: receipt }) + '\n', { flag: 'wx' }); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
    } catch (failure) { error.evidence_error = failure.code ?? 'diagnostic_write_failed'; }
    throw error;
  }

  async function readOwner(file) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (value.schema_version === 1 && Number.isSafeInteger(value.pid) && value.pid > 0
          && typeof value.owner === 'string' && /^[a-f0-9-]{36}$/.test(value.owner)) return value;
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        // NTFS may briefly return EPERM while another owner unlinks its slot.
        if (error.code === 'EPERM' && attempt === 0) { await sleep(pollMs); continue; }
      }
      break;
    }
    return attention('owner_record_unreadable', file);
  }

  async function acquire(options) {
    if (blockedError) throw blockedError;
    checkDeadline(options);
    await mkdir(root, { recursive: true });
    const ticketOwner = { schema_version: 1, pid: process.pid, owner: randomUUID(),
      waiting_only: true, queued_at: new Date(now()).toISOString(),
      ...(options.deadlineAtMs == null ? {} : { deadline_at_ms: options.deadlineAtMs }) };
    const ticket = path.join(root, `waiting-${now()}-${ticketOwner.owner}.json`);
    const temporaryTicket = path.join(root, `owner-${ticketOwner.owner}.json`);
    await writeFile(temporaryTicket, JSON.stringify(ticketOwner) + '\n', { flag: 'wx' });
    try { await link(temporaryTicket, ticket); }
    finally { await unlink(temporaryTicket); }
    try { for (;;) {
      checkDeadline(options);
      try {
        await readFile(attentionFile);
        const error = new Error('account_cli_slots_needs_attention');
        error.code = error.message; error.status = 'needs_attention'; error.receipt_file = attentionFile;
        throw error;
      } catch (error) {
        if (error.code === 'account_cli_slots_needs_attention') throw error;
        if (error.code !== 'ENOENT') return attention('attention_marker_unreadable', attentionFile);
      }
      // A running caller must rejoin the waiting order for its next request.
      // Only waiting tickets (which have never launched a child) may be reclaimed.
      let first = null;
      for (const name of (await readdir(root)).filter(name => /^waiting-\d+-[a-f0-9-]{36}\.json$/.test(name)).sort()) {
        const file = path.join(root, name), pending = await readOwner(file);
        if (!pending) continue;
        if (pending.waiting_only !== true) return attention('invalid_waiting_record', file, pending);
        try { process.kill(pending.pid, 0); }
        catch (error) {
          if (error.code !== 'ESRCH') return attention('waiting_owner_liveness_unknown', file, pending);
          const current = await readOwner(file);
          if (current?.owner === pending.owner) {
            try { await unlink(file); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
          }
          continue;
        }
        first = file; break;
      }
      if (first !== ticket) { await waitForSlot(options); continue; }
      for (const file of slots) {
        checkDeadline(options);
        const owner = { schema_version: 1, pid: process.pid, owner: randomUUID(), acquired_at: new Date().toISOString() };
        const temporary = path.join(root, `owner-${owner.owner}.json`);
        // Publish an already complete owner record. NTFS hard-link creation is
        // atomic and fails with EEXIST; no contender can see a half-written slot.
        await writeFile(temporary, JSON.stringify(owner) + '\n', { flag: 'wx' });
        try { await link(temporary, file); return { file, owner }; }
        catch (error) { if (error.code !== 'EEXIST') return attention('slot_publication_failed', file); }
        finally { await unlink(temporary); }
        const existing = await readOwner(file);
        if (!existing) continue;
        try { process.kill(existing.pid, 0); }
        catch (error) {
          const current = await readOwner(file);
          if (!current || current.owner !== existing.owner) continue;
          return attention(error.code === 'ESRCH' ? 'owner_dead_child_outcome_unknown' : 'owner_liveness_unknown', file, existing);
        }
      }
      await waitForSlot(options);
    } } finally {
      try { await unlink(ticket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async function release(lease) {
    const current = await readOwner(lease.file);
    if (current?.owner !== lease.owner.owner || current?.pid !== lease.owner.pid)
      return attention('owner_changed_before_release', lease.file, current);
    await unlink(lease.file);
  }

  return async (task, { deadlineAtMs = null } = {}) => {
    const options = { deadlineAtMs, queuedAtMs: now() }, lease = await acquire(options);
    // Deadline can pass during a filesystem operation. Nothing has started yet;
    // release only our lease instead of marking another owner's outcome unknown.
    try { checkDeadline(options); }
    catch (error) { await release(lease); throw error; }
    let result;
    try { result = await task(); }
    catch { return attention('runner_threw_child_outcome_unknown', lease.file, lease.owner); }
    // runCodexCli sets terminated only on the child's close event. A thrown or
    // ambiguous runner result retains the slot even if the owner remains alive.
    if (result?.terminated !== true) return attention('child_termination_unconfirmed', lease.file, lease.owner);
    try { await release(lease); }
    catch (error) {
      if (error.code !== 'account_cli_slots_needs_attention') {
        try { await attention('slot_release_failed', lease.file, lease.owner); }
        catch (failure) { error = failure; }
      }
      error.runner_result = result;
      throw error;
    }
    return result;
  };
}
