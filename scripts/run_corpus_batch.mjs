import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, readdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { prepareEpisode } from './prepare_episode.mjs';
import { prepareApiAudio, readJson, shaBytes, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { bindPreparedEpisode, distillEpisode, windowsFor } from './distill_episode.mjs';
import { distillCorpus, RULE_EVIDENCE_COMPILER_REVISION } from './distill_corpus.mjs';
import { createSpecialistResearchObserver } from './specialist_research_runtime.mjs';
import { hashFile } from './render_binding.mjs';
import { validatePublicResearchDerivative } from './research_derivative_binding.mjs';
import { createAccountAuthAdmission, isAuthorizationFailure, validateAuthenticationProbe } from './codex_cli_runtime.mjs';
import { loadEpisodeSchedulingPolicy, applyEpisodeSchedulingPolicy, createEpisodeSchedulingAudit } from './corpus_episode_scheduling.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GiB = 1024 ** 3;
const backends = ['qwen3_asr', 'panns_sed'];
const execute = promisify(execFile);
const terminal = new Set(['research_processed', 'heldout_processed', 'failed_exhausted', 'identity_disputed']);
const incompleteEpisodeCoverage = coverage => coverage?.complete_processed === false
  || coverage?.missing_ranges?.length > 0 || coverage?.unclassified_ranges?.length > 0;
const exists = async file => { try { await access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const binding = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const saveJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value, null, 2) + '\n'); };
const keyFor = value => shaBytes(value).slice(0, 20);
const errorCode = error => error.code ?? error.message ?? 'batch_stage_failed';
const quota = value => /account_quota_wait|codex_cli_quota_exhausted|quota_exhausted/.test(String(value));
const slotAttention = value => /account_(?:cli_)?slots_needs_attention/.test(String(value));
const authorization = value => /codex_cli_authorization_(?:failed|paused)|authorization_paused/.test(String(value));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
const unchanged = async value => value && await exists(value.path) && await hashFile(value.path) === value.sha256;
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const semanticCli = cli => Object.fromEntries(Object.entries(cli ?? {}).filter(([key]) => !['resumeAccountWait', 'transport', 'authResumeEvidence'].includes(key)));
export const engineeringPilotReady = state => state?.engineering_pilot?.status === 'engineering_pilot_ready'
  || state?.pilot?.status === 'pilot_ready';

function clearResolvedError(item) {
  if (!item.error && !item.error_receipt && !quota(item.status)) return;
  item.resolved_errors ??= [];
  item.resolved_errors.push({ resolved_at: new Date().toISOString(), prior_status: item.status, error: item.error ?? null,
    error_receipt: item.error_receipt ?? null, cli_receipts: item.cli_receipts ?? [],
    rule_synthesis_cli_receipts: item.result?.rule_synthesis?.cli_receipts ?? [] });
  item.error = null; item.error_receipt = null;
}

export async function acquireBatchLock(lockFile) {
  const token = randomUUID(), claimFile = lockFile + '.claim';
  let claim;
  try { claim = await open(claimFile, 'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('batch_lock_acquisition_in_progress'); throw error; }
  try {
    await claim.writeFile(JSON.stringify({ pid: process.pid, owner_token: token }));
    if (await exists(lockFile)) {
      const bytes = await readFile(lockFile), owner = JSON.parse(bytes.toString('utf8'));
      if (!Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('batch_lock_owner_unknown');
      if (isAlive(owner.pid)) throw new Error('batch_already_running');
      if (!(await readFile(lockFile)).equals(bytes)) throw new Error('batch_lock_owner_changed');
      await rename(lockFile, path.join(path.dirname(lockFile), `stale-lock-${token}.json`));
    }
    const lock = await open(lockFile, 'wx');
    try { await lock.writeFile(JSON.stringify({ pid: process.pid, owner_token: token, started_at: new Date().toISOString() })); }
    finally { await lock.close(); }
  } finally { await claim.close(); await unlink(claimFile); }
  return async () => {
    if (await exists(lockFile) && (await readJson(lockFile)).owner_token === token) await unlink(lockFile);
  };
}

async function checkedDocument(file) {
  if (!file?.path || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) throw new Error('snapshot_extension_binding_required');
  const bytes = await readFile(file.path);
  if (shaBytes(bytes) !== file.sha256) throw new Error('snapshot_extension_evidence_changed');
  return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
}

function entryIndex(document) {
  if (!Array.isArray(document?.entries)) throw new Error('snapshot_extension_entries_required');
  const rows = new Map();
  for (const row of document.entries) {
    if (!row.episode_id || rows.has(row.episode_id)) throw new Error('snapshot_extension_duplicate_episode');
    rows.set(row.episode_id, row);
  }
  return rows;
}

export async function validateSnapshotExtension(config, state, identity, document, candidateDocument, catalog) {
  const safeDrained = state.status === 'drained' && config.allow_snapshot_on_drained === true;
  const activeOrUnknown = safeDrained ? /quota|unknown|running|directing|preparing|process_wait/ : /quota|unknown|running|directing|preparing|process_wait|storage_paused/;
  if (config.phase !== 'all' || !safeDrained && state.status !== 'batch_finished_with_gaps' || !engineeringPilotReady(state)
    || Object.values(state.episodes).some(row => activeOrUnknown.test(`${row.status}:${row.error}`))
    || Object.values(state.works).some(row => /quota|unknown|aggregating/.test(`${row.status}:${row.error}`)
      || !safeDrained && /storage_paused/.test(`${row.status}:${row.error}`)))
    throw new Error('snapshot_extension_requires_completed_current_queue');
  const fixed = value => ({ ...Object.fromEntries(Object.entries(value).filter(([key]) => !['manifest_sha256', 'candidate_manifest_sha256'].includes(key))), cli: semanticCli(value.cli) });
  if (canonical(fixed(state.identity)) !== canonical(fixed(identity))) throw new Error('snapshot_extension_fixed_identity_changed');
  const receipt = await binding(config.snapshot_extension_file), extension = await checkedDocument(receipt);
  const receiptFixed = structuredClone(extension.unchanged_identity_fields);
  // A frozen append receipt may predate an explicitly audited layout-only migration.
  // No source, model, library or split identity is translated here.
  let layout = receiptFixed?.director_contact_sheet_tool;
  for (const upgrade of state.processing_upgrades ?? []) {
    if (layout === identity.director_contact_sheet_tool) break;
    if (upgrade.prior_contact_sheet_tool_sha256 !== layout || !upgrade.reason?.trim()
      || !Number.isFinite(Date.parse(upgrade.applied_at))
      || upgrade.prior_identity?.director_contact_sheet_tool !== layout
      || canonical(fixed(upgrade.prior_identity)) !== canonical(fixed({ ...identity, director_contact_sheet_tool: layout }))) continue;
    layout = upgrade.next_contact_sheet_tool_sha256;
  }
  if (receiptFixed && layout === identity.director_contact_sheet_tool) receiptFixed.director_contact_sheet_tool = layout;
  if (extension.schema_version !== 1 || extension.kind !== 'append_only_corpus_extension'
    || extension.old?.media?.sha256 !== state.identity.manifest_sha256
    || extension.old?.candidates?.sha256 !== state.identity.candidate_manifest_sha256
    || extension.next?.media?.sha256 !== identity.manifest_sha256
    || extension.next?.candidates?.sha256 !== identity.candidate_manifest_sha256
    || path.resolve(extension.next.media.path) !== path.resolve(config.manifest_file)
    || path.resolve(extension.next.candidates.path) !== path.resolve(config.candidate_manifest)
    || extension.catalog?.sha256 !== identity.catalog_sha256
    || canonical(receiptFixed) !== canonical(fixed(identity))) throw new Error('snapshot_extension_identity_mismatch');
  const oldMedia = await checkedDocument(extension.old.media), oldCandidates = await checkedDocument(extension.old.candidates);
  if (canonical(await checkedDocument(extension.next.media)) !== canonical(document)
    || canonical(await checkedDocument(extension.next.candidates)) !== canonical(candidateDocument)
    || canonical(await checkedDocument(extension.catalog)) !== canonical(catalog)) throw new Error('snapshot_extension_document_changed');
  const oldRows = entryIndex(oldMedia), nextRows = entryIndex(document), oldCandidateRows = entryIndex(oldCandidates), nextCandidates = entryIndex(candidateDocument);
  if (!safeDrained && [...oldRows.keys()].some(id => !terminal.has(state.episodes[id]?.status))) throw new Error('snapshot_extension_requires_completed_current_queue');
  for (const [id, row] of oldRows) if (canonical(nextRows.get(id)) !== canonical(row)) throw new Error('snapshot_extension_old_episode_changed');
  for (const [id, row] of oldCandidateRows) if (canonical(nextCandidates.get(id)) !== canonical(row)) throw new Error('snapshot_extension_old_candidate_changed');
  const added = [...nextRows.keys()].filter(id => !oldRows.has(id)), addedCandidates = [...nextCandidates.keys()].filter(id => !oldCandidateRows.has(id));
  if (!added.length || canonical([...added].sort()) !== canonical([...(extension.added_episode_ids ?? [])].sort())
    || canonical([...added].sort()) !== canonical(addedCandidates.sort())) throw new Error('snapshot_extension_added_identity_mismatch');
  const groups = new Map(), works = new Map(catalog.works.map(row => [row.work_id, row]));
  for (const work of catalog.works) {
    const group = work.series_group_id ?? work.group_id ?? work.work_id;
    if (groups.has(group) && groups.get(group) !== work.split) throw new Error('snapshot_extension_group_split_conflict');
    groups.set(group, work.split);
  }
  const proof = new Map((extension.verified_new_sources ?? []).map(row => [row.episode_id, row]));
  if (proof.size !== added.length || proof.size !== (extension.verified_new_sources ?? []).length) throw new Error('snapshot_extension_source_proof_required');
  const acquisitions = await Promise.all((extension.acquisitions ?? [extension.acquisition]).map(checkedDocument));
  const acquiredByRecord = new Map();
  for (const document of acquisitions) for (const work of document.works ?? []) for (const episode of work.episodes ?? []) {
    const record = canonical({ work: Object.fromEntries(['work_id', 'platform_series_id', 'source_version_id', 'split'].map(key => [key, work[key]])), episode });
    if (!acquiredByRecord.has(record)) acquiredByRecord.set(record, { document, work, episode });
  }
  const acquired = [...acquiredByRecord.values()];
  for (const id of added) {
    const row = nextRows.get(id), candidate = nextCandidates.get(id), work = works.get(row.work_id), evidence = proof.get(id);
    const group = row.series_group_id ?? row.group_id;
    if (!work || row.split !== work.split || groups.get(group) !== row.split
      || group !== (work.series_group_id ?? work.group_id ?? work.work_id)
      || [...oldRows.values()].some(prior => prior.work_id === row.work_id && prior.split !== row.split)) throw new Error('snapshot_extension_heldout_identity_changed');
    if (row.confirmed_catalogue_episode !== false || row.counts_toward_screenshot_coverage !== false || row.research_input_eligible !== true
      || row.full_decode_success !== true || row.source_video_sha256 !== row.sha256
      || !candidate || candidate.research_input_eligible !== true || candidate.confirmed_catalogue_episode !== false
      || ['work_id', 'episode_id', 'source_version', 'sha256', 'split', 'episode_number', 'platform_series_id'].some(key => row[key] !== candidate[key])
      || path.resolve(row.video) !== path.resolve(candidate.video) || !evidence || evidence.sha256 !== row.sha256
      || evidence.source_version !== row.source_version || evidence.split !== row.split || evidence.work_id !== row.work_id
      || path.resolve(evidence.video) !== path.resolve(row.video) || evidence.acquisition_record_bound !== true
      || evidence.full_decode_receipt_matched !== true) throw new Error('snapshot_extension_source_identity_mismatch');
    const derivative = row.transform?.kind === 'exact_matching_insert_byte_removal_and_copy_remux';
    const matches = acquired.filter(({ work: sourceWork, episode }) => sourceWork.work_id === row.work_id
      && sourceWork.platform_series_id === row.platform_series_id && episode.episode_number === row.episode_number
      && episode.source_episode_id === row.source_episode_id);
    if (matches.length !== 1
      || matches[0].episode.status !== (derivative ? 'verified_local_research_derivative' : 'acquired_verified')
      || matches[0].episode.media?.sha256 !== row.sha256 || matches[0].episode.media?.full_decode_success !== true
      || matches[0].episode.media?.publication_verified_by_sha256 === false
      || path.resolve(matches[0].episode.media.path) !== path.resolve(row.video)
      || matches[0].work.split !== row.split || matches[0].work.source_version_id !== row.source_version_id)
      throw new Error('snapshot_extension_acquisition_evidence_mismatch');
    if (derivative && canonical(await validatePublicResearchDerivative(row, candidate, matches[0], evidence.research_derivative?.evidence_files))
      !== canonical(evidence.research_derivative)) throw new Error('snapshot_extension_derivative_proof_changed');
    if (await hashFile(row.video) !== row.sha256) throw new Error('snapshot_extension_actual_source_changed');
    const frames = row.identity_evidence?.frames;
    if (!frames?.length || canonical(frames) !== canonical(candidate.identity_evidence?.frames)
      || row.identity_evidence?.public_source_check?.passed !== true || row.actual_frames_observed !== true)
      throw new Error('snapshot_extension_frame_identity_required');
    for (const frame of frames) if (!(frame.time_seconds >= 0 && frame.time_seconds < row.duration_seconds)
      || await hashFile(frame.path) !== frame.sha256) throw new Error('snapshot_extension_frame_changed');
  }
  if (!await unchanged(receipt)) throw new Error('snapshot_extension_evidence_changed');
  return { admitted_at: new Date().toISOString(), receipt, old_identity: state.identity, next_identity: identity,
    added_episode_ids: added, preserved_old_episodes: oldRows.size, preserved_old_candidates: oldCandidateRows.size,
    prior_pilot: state.pilot, screenshot_coverage_added: 0, safe_drained_append: safeDrained };
}

export async function validateEpisodeRecoveries(operations, state, entries) {
  const planned = [], ids = new Set();
  for (const operation of operations ?? []) {
    if (!operation.episode_id || ids.has(operation.episode_id) || !operation.reason?.trim()) throw new Error('explicit_unique_episode_recovery_required');
    if (operation.kind !== undefined && !['lost_response', 'authorization_failure', 'storage_resume'].includes(operation.kind))
      throw new Error('episode_recovery_kind_invalid');
    ids.add(operation.episode_id);
    const recoveryId = shaBytes(canonical(operation)), item = state.episodes[operation.episode_id];
    if (item?.recovery_history?.some(row => row.recovery_id === recoveryId)) continue;
    const entry = entries.find(row => row.episode_id === operation.episode_id);
    if (operation.kind === 'storage_resume') {
      if (!item || !entry || item.status !== 'storage_paused' || item.error !== 'storage_paused'
        || operation.source_video_sha256 !== entry.sha256 || item.source_sha256 !== entry.sha256)
        throw new Error('storage_recovery_source_or_state_mismatch');
      const audit = await checkedDocument(operation.storage_audit);
      if (audit.kind !== 'checkpoint_storage_resume_audit' || audit.episode_id !== entry.episode_id
        || audit.source_video_sha256 !== entry.sha256 || audit.storage_ready !== true
        || !path.isAbsolute(audit.checkpoint_root ?? '') || !Number.isFinite(Date.parse(audit.observed_at))
        || Date.parse(audit.observed_at) > Date.now() || Date.now() - Date.parse(audit.observed_at) > 60 * 60000)
        throw new Error('storage_recovery_current_audit_required');
      await storageCheck(audit.checkpoint_root);
      if (await hashFile(entry.video) !== entry.sha256) throw new Error('episode_recovery_source_changed');
      planned.push({ ...operation, recovery_id: recoveryId, admitted_at: new Date().toISOString(),
        prior_status: item.status, prior_error: item.error, prior_error_receipt: item.error_receipt ?? null,
        prior_result: item.result ?? null, prior_recovery_id: item.active_recovery_id ?? null,
        prior_error_detail: 'unknown_preserved', successful_preparation_preserved: true });
      continue;
    }
    if (operation.kind === 'lost_response') {
      if (!item || !entry || !['directing', 'needs_attention', 'failed_exhausted'].includes(item.status)
        || operation.source_video_sha256 !== entry.sha256 || item.source_sha256 !== entry.sha256
        || !operation.request_states?.length) throw new Error('lost_response_source_or_state_mismatch');
      const audit = await checkedDocument(operation.process_exit_evidence);
      if (audit.kind !== 'corpus_process_exit_audit' || audit.execution_kind !== 'local_process_inspection'
        || !Number.isFinite(Date.parse(audit.observed_at)) || Date.parse(audit.observed_at) > Date.now()
        || Date.now() - Date.parse(audit.observed_at) > 60 * 60000
        || !audit.terminated_process_ids?.length || audit.terminated_process_ids.some(pid => !Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid))
        || !Array.isArray(audit.live_matching_process_ids) || audit.live_matching_process_ids.length !== 0)
        throw new Error('lost_response_process_exit_evidence_required');
      for (const row of operation.request_states) {
        const priorState = await checkedDocument(row.state), request = await checkedDocument(row.request);
        if (!['running', 'outcome_unknown'].includes(priorState.status)
          || priorState.request_sha256 !== shaBytes(canonical(request)) || request.role !== 'director'
          || request.source_video_sha256 !== entry.sha256 || request.execution_kind !== 'codex_cli_inference'
          || !audit.inspected_scopes?.includes(path.resolve(path.dirname(row.state.path))))
          throw new Error('lost_response_request_binding_mismatch');
        // Archived attempts remain unknown/failures; their usage is never reset.
        for (const receipt of priorState.attempts ?? []) await checkedDocument(receipt);
      }
      if (await hashFile(entry.video) !== entry.sha256) throw new Error('episode_recovery_source_changed');
      planned.push({ ...operation, recovery_id: recoveryId, admitted_at: new Date().toISOString(),
        prior_status: item.status, prior_error: item.error ?? null, prior_result: item.result ?? null,
        prior_recovery_id: item.active_recovery_id ?? null,
        prior_cli_outcome: 'unknown_preserved', no_success_or_usage_inferred: true });
      continue;
    }
    if (!item || !entry || item.status !== 'failed_exhausted' || /unknown|quota/.test(item.error ?? '')
      || operation.source_video_sha256 !== entry.sha256 || item.source_sha256 !== entry.sha256
      || canonical(operation.prior_result) !== canonical(item.result)) throw new Error('episode_recovery_source_or_status_mismatch');
    const prior = await checkedDocument(operation.prior_result);
    if (prior.source_video_sha256 !== entry.sha256 || /unknown|quota/.test(`${prior.status}:${prior.error}`)
      || !prior.cli_receipts?.length || canonical(prior.cli_receipts) !== canonical(operation.terminated_cli_receipts))
      throw new Error('episode_recovery_complete_termination_evidence_required');
    let failedReceipts = 0;
    for (const file of operation.terminated_cli_receipts) {
      const receipt = await checkedDocument(file);
      if (receipt.execution_kind !== 'codex_cli_inference' || receipt.stage !== 'director' || receipt.source_video_sha256 !== entry.sha256
        || receipt.process_terminated !== true || !['complete', 'timeout', 'semantic_invalid', 'schema_invalid', 'failed', 'authorization_failed', 'final_event_mismatch', 'source_mismatch', 'model_mismatch', 'evidence_changed'].includes(receipt.status))
        throw new Error('episode_recovery_unknown_or_unterminated_outcome');
      if (operation.kind === 'authorization_failure' && receipt.status !== 'complete') {
        const events = await checkedDocument(receipt.request);
        if (events.source_video_sha256 !== entry.sha256) throw new Error('authorization_recovery_request_mismatch');
        if (!await unchanged(receipt.stderr) || !await unchanged(receipt.jsonl)) throw new Error('authorization_recovery_evidence_changed');
        if (!isAuthorizationFailure(await readFile(receipt.stderr.path, 'utf8') + '\n' + await readFile(receipt.jsonl.path, 'utf8')))
          throw new Error('authorization_recovery_requires_401_evidence');
      }
      if (receipt.status !== 'complete') failedReceipts++;
    }
    if (!failedReceipts) throw new Error('episode_recovery_actual_failure_receipt_required');
    if (operation.kind === 'authorization_failure') await validateAuthenticationProbe(operation.authentication_probe);
    if (await hashFile(entry.video) !== entry.sha256) throw new Error('episode_recovery_source_changed');
    planned.push({ episode_id: entry.episode_id, recovery_id: recoveryId, admitted_at: new Date().toISOString(), reason: operation.reason,
      prior_status: item.status, prior_error: item.error, prior_result: item.result, terminated_cli_receipts: operation.terminated_cli_receipts,
      prior_recovery_id: item.active_recovery_id ?? null,
      source_video_sha256: entry.sha256, ...(operation.kind ? { kind: operation.kind, authentication_probe: operation.authentication_probe } : {}) });
  }
  return planned;
}

export async function validateWorkCancellationRecovery(operation, state, accountDirectory) {
  if (!operation) return null;
  const recoveryId = shaBytes(canonical(operation));
  if (state.work_cancellation_recoveries?.some(row => row.recovery_id === recoveryId)) return null;
  if (!operation.reason?.trim()) throw new Error('work_cancellation_reason_required');
  const audit = await checkedDocument(operation.audit), prior = await checkedDocument(audit.prior_batch);
  const work = state.works[audit.canceled_work_id], ticket = await checkedDocument(audit.ticket_archive);
  if (audit.kind !== 'queued_work_process_cancel_audit' || audit.execution_kind !== 'local_process_inspection'
    || audit.waiting_only !== true || audit.no_model_process_killed !== true || audit.batch_claimed_drained !== false
    || audit.guard_wait_ms < 500 || audit.owned_active_slots !== 0 || audit.child_processes !== 0
    || audit.live_matching_process_ids?.length !== 0 || !audit.terminated_process_ids?.length
    || audit.terminated_process_ids.some(pid => !Number.isSafeInteger(pid) || pid <= 0 || isAlive(pid))
    || ticket.waiting_only !== true || !audit.terminated_process_ids.includes(ticket.pid)
    || !Number.isFinite(Date.parse(audit.observed_at)) || Date.parse(audit.observed_at) > Date.now()
    || Date.now() - Date.parse(audit.observed_at) > 60 * 60000
    || canonical(prior) !== canonical(state) || work?.status !== 'aggregating')
    throw new Error('work_cancellation_closed_waiting_evidence_required');
  for (const name of ['slot-1.json', 'slot-2.json']) {
    const file = path.join(accountDirectory, name);
    if (await exists(file) && audit.terminated_process_ids.includes((await readJson(file)).pid))
      throw new Error('work_cancellation_active_slot_retained');
  }
  return { recovery_id: recoveryId, operation, work_id: audit.canceled_work_id,
    admitted_at: new Date().toISOString(), prior_work: structuredClone(work),
    canceled_scope: 'queued_before_invocation', no_completed_request_replayed: true };
}

function gate() {
  let previous = Promise.resolve();
  return action => { const result = previous.then(action); previous = result.catch(() => {}); return result; };
}

// This classifies the displayed frame, not the orientation of letterboxed content.
export function classifySourceFormatProbe(probe) {
  const stream = (probe.streams ?? []).find(row => row.codec_type === 'video');
  if (!stream) return { raw_width: null, raw_height: null, sample_aspect_ratio: null, rotation_degrees: null,
    display_aspect_ratio: null, orientation: 'unknown', orientation_reason: 'missing_video_stream' };
  const ratio = value => { const parts = String(value ?? '').split(/[:/]/).map(Number);
    return parts.length === 2 && parts[0] > 0 && parts[1] > 0 ? parts[0] / parts[1] : null; };
  const width = Number(stream.width), height = Number(stream.height);
  const rotation = Number(stream.side_data_list?.find(row => row.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  const sar = ratio(stream.sample_aspect_ratio), dar = ratio(stream.display_aspect_ratio);
  let display = width > 0 && height > 0 && sar !== null ? width * sar / height : dar;
  const rightAngle = Number.isFinite(rotation) && Math.abs(rotation / 90 - Math.round(rotation / 90)) < 0.00001;
  if (!rightAngle) display = null;
  else if (Math.abs(Math.round(rotation / 90)) % 2 === 1 && display) display = 1 / display;
  return { raw_width: Number.isFinite(width) ? width : null, raw_height: Number.isFinite(height) ? height : null,
    sample_aspect_ratio: stream.sample_aspect_ratio ?? null, raw_display_aspect_ratio: stream.display_aspect_ratio ?? null,
    rotation_degrees: Number.isFinite(rotation) ? rotation : null,
    rotation_basis: stream.side_data_list?.some(row => row.rotation !== undefined) ? 'display_matrix'
      : stream.tags?.rotate !== undefined ? 'rotate_tag' : 'no_rotation_metadata',
    display_aspect_ratio: display,
    orientation: !Number.isFinite(display) || display <= 0 ? 'unknown' : Math.abs(display - 1) <= 0.01 ? 'square' : display < 1 ? 'vertical' : 'horizontal',
    orientation_reason: !rightAngle ? 'unsupported_non_right_angle_rotation' : display ? 'display_ratio_with_rotation' : 'missing_sample_or_display_aspect_ratio' };
}

export async function validateSourceFormatManifest(file, entries) {
  const readBound = async value => {
    if (!value?.path || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) throw new Error('source_format_binding_required');
    const bytes = await readFile(value.path);
    if (shaBytes(bytes) !== value.sha256) throw new Error('source_format_evidence_changed');
    return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  };
  const document = await readBound(file), source = await readBound(document.source_manifest);
  if (document.schema_version !== 1 || !Array.isArray(document.entries) || !Array.isArray(source.entries))
    throw new Error('source_format_manifest_required');
  const indexed = rows => {
    const result = new Map();
    for (const row of rows) {
      if (!row.episode_id || result.has(row.episode_id)) throw new Error('source_format_duplicate_episode');
      result.set(row.episode_id, row);
    }
    return result;
  };
  const formats = indexed(document.entries), sources = indexed(source.entries), verified = new Map();
  for (const entry of entries) {
    const row = formats.get(entry.episode_id), original = sources.get(entry.episode_id);
    if (!row || !original) throw new Error('source_format_episode_missing');
    if (['episode_id', 'work_id', 'source_version', 'split', 'episode_number', 'platform', 'platform_series_id'].some(key =>
      entry[key] !== original[key] || entry[key] !== row[key]) || original.sha256 !== entry.sha256
      || row.source_video_sha256 !== entry.sha256 || path.resolve(original.video) !== path.resolve(entry.video)
      || !row.source_video_path || path.resolve(row.source_video_path) !== path.resolve(entry.video))
      throw new Error('source_format_source_identity_mismatch');
    const receipt = await readBound(row.probe_receipt);
    if (receipt.schema_version !== 1 || receipt.episode_id !== entry.episode_id || receipt.exit_code !== 0 || receipt.error
      || row.source_hash_verified !== true || receipt.source?.sha256_verified !== true
      || receipt.source.sha256 !== entry.sha256 || !receipt.source.path || path.resolve(receipt.source.path) !== path.resolve(entry.video)
      || !receipt.ffprobe?.path || !receipt.ffprobe?.version || !receipt.probe || !Array.isArray(receipt.probe.streams)
      || !Number.isSafeInteger(receipt.source.size_bytes) || receipt.source.size_bytes <= 0
      || (await stat(entry.video)).size !== receipt.source.size_bytes
      || Number(receipt.probe.format?.size) !== receipt.source.size_bytes)
      throw new Error('source_format_probe_receipt_mismatch');
    const actual = classifySourceFormatProbe(receipt.probe);
    if (Object.entries(actual).some(([key, value]) => canonical(row[key]) !== canonical(value)))
      throw new Error('source_format_metadata_mismatch');
    verified.set(entry.episode_id, { episode_id: entry.episode_id, source_video_sha256: entry.sha256,
      ...actual, probe_receipt: row.probe_receipt });
  }
  // Full media hashes are checked by processEntry before reuse or processing.
  // Never promote content_orientation from container metadata or use it to rank.
  return { binding: { path: path.resolve(file.path), sha256: file.sha256 }, source_manifest: document.source_manifest, entries: verified };
}

export function planCorpusBatch(document, config, candidateDocument = null, sourceFormats = null) {
  if (!['pilot', 'all'].includes(config.phase)) throw new Error('batch_phase_required');
  if (config.prefer_vertical !== undefined && typeof config.prefer_vertical !== 'boolean') throw new Error('prefer_vertical_boolean_required');
  const seen = new Set(), workSplits = new Map(), candidates = [], confirmed = [], admittedCandidates = [];
  const eligible = new Map((candidateDocument?.entries ?? []).map(row => [row.episode_id, row]));
  for (const row of document.entries ?? []) {
    if (!row.work_id || !row.episode_id || !row.video || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
      || !row.source_version || !['research', 'heldout'].includes(row.split)) throw new Error('bound_batch_episode_required');
    if (row.source_range != null) throw new Error('unmapped_source_range_requires_episode_file');
    if (seen.has(row.episode_id)) throw new Error('duplicate_batch_episode_id');
    if (workSplits.has(row.work_id) && workSplits.get(row.work_id) !== row.split) throw new Error('work_split_conflict');
    workSplits.set(row.work_id, row.split);
    seen.add(row.episode_id);
    (row.confirmed_catalogue_episode === true ? confirmed : candidates).push(row);
    const candidate = eligible.get(row.episode_id);
    if (!row.confirmed_catalogue_episode && candidate?.research_input_eligible === true) {
      if (candidate.sha256 !== row.sha256 || candidate.work_id !== row.work_id || candidate.source_version !== row.source_version
        || candidate.split !== row.split || path.resolve(candidate.video) !== path.resolve(row.video)
        || candidate.confirmed_catalogue_episode !== false) throw new Error('candidate_identity_binding_mismatch');
      admittedCandidates.push(row);
    }
  }
  const pilot = confirmed.filter(row => row.work_id === config.pilot_work_id && row.platform === 'thepaper');
  if (!pilot.length || pilot.some(row => row.split !== 'research')) throw new Error('research_pilot_required');
  const preferVertical = config.phase === 'all' && config.prefer_vertical === true;
  const priority = row => {
    const format = sourceFormats?.get(row.episode_id);
    if (!format || format.source_video_sha256 !== row.sha256) throw new Error('verified_source_format_required');
    return row.split === 'heldout' ? 3 : format.orientation === 'vertical' ? 0 : format.orientation === 'horizontal' ? 1 : 2;
  };
  if (preferVertical) for (const row of [...confirmed, ...admittedCandidates]) priority(row);
  const inputs = (config.phase === 'pilot' ? pilot : [...confirmed, ...admittedCandidates]).toSorted((a, b) =>
    (preferVertical ? priority(a) - priority(b) : 0)
    || Number(b.work_id === config.pilot_work_id) - Number(a.work_id === config.pilot_work_id)
    || a.work_id.localeCompare(b.work_id) || String(a.platform).localeCompare(String(b.platform))
    || String(a.platform_series_id ?? a.official_series_id).localeCompare(String(b.platform_series_id ?? b.official_series_id))
    || a.episode_number - b.episode_number || a.source_version.localeCompare(b.source_version));
  return { inputs, pilot, candidates, admitted_candidates: admittedCandidates, confirmed_count: confirmed.length,
    heldout_count: [...confirmed, ...admittedCandidates].filter(row => row.split === 'heldout').length };
}

async function treeBytes(root) {
  let size = 0;
  for (const item of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) size += await treeBytes(file);
    else if (item.isFile()) size += (await stat(file)).size;
  }
  return size;
}

export async function storageCheck(root) {
  const disk = await statfs(root);
  const observation = { checkpoint_root: root, available_bytes: disk.bavail * disk.bsize, cache_bytes: await treeBytes(root),
    minimum_available_bytes: 2 * GiB, maximum_cache_bytes: GiB, observed_at: new Date().toISOString() };
  if (observation.available_bytes < observation.minimum_available_bytes)
    throw Object.assign(new Error('checkpoint_disk_reserve_below_2gib'), { code: 'storage_paused', storage_observation: observation });
  if (observation.cache_bytes > observation.maximum_cache_bytes)
    throw Object.assign(new Error('checkpoint_cache_exceeds_1gib'), { code: 'storage_paused', storage_observation: observation });
  return observation;
}

async function runSpecialist(configFile, options) {
  const stdout = createWriteStream(options.stdout), stderr = createWriteStream(options.stderr);
  let child;
  const completion = new Promise((resolve, reject) => {
    child = spawn(options.python, [path.join(here, 'specialist_audio_observer.py'), '--config', configFile], {
      windowsHide: true, env: { ...process.env, ...options.environment }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(stdout); child.stderr.pipe(stderr);
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`specialist_process_exit_${code}`)));
  });
  if (child.pid) await options.onSpawn?.(child.pid);
  await completion;
}

export const materialSchema = {
  type: 'object', additionalProperties: false, required: ['schema_version', 'tasks', 'gaps', 'case_gaps'], properties: {
    schema_version: { type: 'integer', enum: [1] },
    tasks: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['case_id', 'step_id', 'source_event_id', 'query', 'reason', 'sound_role'], properties: {
        case_id: { type: 'string' }, step_id: { type: 'string' }, source_event_id: { type: 'string' }, reason: { type: 'string' },
        sound_role: { type: ['string', 'null'], enum: ['physical', 'dramatic', 'transition', 'ambience', null] },
        query: { type: 'object', additionalProperties: false, required: ['asset_kind', 'text'], properties: {
          asset_kind: { type: 'string', enum: ['music', 'sfx', 'ambience'] }, text: { type: 'string' },
        } },
      } } }, gaps: { type: 'array', items: { type: 'string' } },
    case_gaps: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['case_id', 'reason'], properties: { case_id: { type: 'string' }, reason: { type: 'string' } } } },
  },
};

export const materialPlanPrompt = '为给定真实研究case的发展步骤设计明确的正向声音检索任务。case_id/step_id/source_event_id必须来自输入并互相对应。query.text用于SQLite FTS标题/标签检索，不是语义音频检索；使用1至3个简短正向英文库关键词，避免长句或多个风格AND过约束。音乐sound_role=null，其他声音sound_role必须为physical/dramatic/transition/ambience之一。reason须说明剧情功能及尚未核实的适配假设，不可自称参考原曲、听审通过或编造歌曲。每个输入case必须有任务，或在case_gaps中以准确case_id和具体reason明确记录不需要新增素材或仍无法提出有依据声型的缺口；自由文本gaps不能代替逐case结论。不得选中或批准素材。';

export function materialPlanCoverage(value, cases) {
  const expected = new Set(cases.map(row => row.case_id)), tasks = new Set(value.tasks.map(row => row.case_id)), gaps = new Set();
  for (const row of value.case_gaps ?? []) {
    if (!expected.has(row.case_id) || gaps.has(row.case_id) || !row.reason?.trim()) throw new Error('material_plan_bound_case_gap_invalid');
    gaps.add(row.case_id);
  }
  if ([...tasks].some(id => !expected.has(id))) throw new Error('material_plan_unknown_case');
  return { task_case_ids: [...tasks], explicit_gap_case_ids: [...gaps],
    missing_case_ids: [...expected].filter(id => !tasks.has(id) && !gaps.has(id)) };
}

export function validateMaterialPlan(value, cases) {
  // Older successful plans predate structured case gaps; preserve them only after the same coverage checks.
  validateSchema(Object.hasOwn(value, 'case_gaps') ? value : { ...value, case_gaps: [] }, materialSchema);
  const ids = new Map(cases.map(row => [row.case_id, row])), seen = new Set();
  for (const task of value.tasks) {
    const item = ids.get(task.case_id), step = item?.development_preset?.steps.find(row => row.step_id === task.step_id);
    if (!step || step.source_event_id !== task.source_event_id || !item.source_events?.some(row => row.event_id === task.source_event_id)
      || !task.reason.trim() || !task.query.text.trim()) throw new Error('material_task_case_step_event_mismatch');
    if (task.query.asset_kind === 'music' ? task.sound_role !== null : task.sound_role === null)
      throw new Error('material_task_sound_role_required');
    const key = JSON.stringify([task.case_id, task.step_id, task.query.asset_kind, task.sound_role]);
    if (seen.has(key)) throw new Error('duplicate_material_task');
    seen.add(key);
  }
  const coverage = materialPlanCoverage(value, cases);
  if (coverage.missing_case_ids.length) throw Object.assign(new Error('material_plan_case_coverage_incomplete'), coverage);
}

export async function makeRuntime(config, options, injected) {
  const materialKind = config.material_observer_kind ?? 'local_model_receipts';
  if (config.material_observation_execution && materialKind !== 'specialist_receipts')
    throw new Error('material_window_execution_requires_specialist_receipts');
  if (!['local_model_receipts', 'specialist_receipts', 'frozen_offline'].includes(materialKind))
    throw new Error('unknown_material_observer_kind');
  let cli;
  if (injected.createCliRuntime) cli = await injected.createCliRuntime(options);
  else {
    const { createCodexCliRuntime } = await import('./codex_cli_runtime.mjs');
    const { createAccountCliSchedule } = await import('./account_cli_slots.mjs');
    const accountDirectory = config.account_cli_slot_directory ?? path.join(path.resolve(config.checkpoint_root), 'account-cli-slots');
    const admission = createAccountAuthAdmission(accountDirectory);
    if (config.cli?.authResumeEvidence) await admission.resume(config.cli.authResumeEvidence);
    cli = createCodexCliRuntime({ ...config.cli, ...options,
      authAdmission: admission, schedule: createAccountCliSchedule({ directory: accountDirectory }) });
  }
  if (typeof injected.materialObserver === 'function') {
    if (!injected.materialObserver_backend_id?.trim() || !injected.materialObserver_model_revision?.trim())
      throw new Error('material_observer_runtime_identity_required');
    cli = { ...cli, materialObserver: injected.materialObserver,
      materialObserver_backend_id: injected.materialObserver_backend_id,
      materialObserver_model_revision: injected.materialObserver_model_revision };
  } else if (materialKind === 'frozen_offline') {
    if(config.material_readiness_policy!=='offline_ready_only'||config.material_observation_execution)
      throw new Error('offline_materials_cannot_run_online_inference');
    const {createFrozenMaterialObserver}=await import('./offline_material_readiness.mjs');
    cli={...cli,...await createFrozenMaterialObserver({publication:config.music_packs?.publication??config.music_packs})};
    if(config.sfx_library?.publication){
      const {createFrozenSoundMaterialObserver}=await import('./frozen_sound_material_observer.mjs');
      const soundRuntime=await createFrozenSoundMaterialObserver(config.sfx_library);
      // The sound adapter exposes legacy generic aliases for standalone callers.
      // A joint music/SFX runtime must preserve its distinct music observer.
      cli={...cli,...Object.fromEntries(['sfxMaterialObserver','sfxMaterialObserverBatch',
        'sfxMaterialObserver_backend_id','sfxMaterialObserver_model_revision','sfxAnchorMeasurer']
        .map(key=>[key,soundRuntime[key]]))};
    }
  } else if (config.material_observation_receipts?.length || config.material_observation_execution) {
    if (materialKind === 'specialist_receipts') {
      const { createSpecialistMaterialObserver } = await import('./specialist_material_observer.mjs');
      cli = { ...cli, ...await createSpecialistMaterialObserver({ receipts: config.material_observation_receipts ?? [],
        featureReceipts: config.material_acoustic_receipts ?? [],
        requiredBackends: ['qwen3_asr', 'panns_sed'], execution: config.material_observation_execution }) };
    } else {
      const { createLocalMaterialObserver } = await import('./local_material_observer.mjs');
      cli = { ...cli, ...await createLocalMaterialObserver({ receipts: config.material_observation_receipts,
        model_revision: config.material_observer_model_revision, backend_id: config.material_observer_backend_id }) };
    }
  }
  if (typeof cli.materialSelector === 'function' && config.python) cli = withMaterialContactSheets(cli,
    (input, id, output) => prepareDirectorSheets(input,
      path.join(output, 'material-contact-sheets', shaBytes(JSON.stringify([id, input.frames])).slice(0, 20)),
      config.contact_sheet_python ?? config.python));
  return cli;
}

export async function prepareDirectorSheets(input, directory, python) {
  await mkdir(directory, { recursive: true });
  const inputFile = path.join(directory, 'contact-input.json'), output = path.join(directory, 'sheets');
  const data = { frames: input.frames };
  if (await exists(inputFile)) {
    if (JSON.stringify(await readJson(inputFile)) !== JSON.stringify(data)) throw new Error('contact_input_changed');
  } else await saveJson(inputFile, data);
  await execute(python, [path.join(here, 'prepare_director_contact_sheets.py'), '--input', inputFile, '--output-dir', output],
    { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const manifest = await binding(path.join(output, 'manifest.json'));
  return { ...await readJson(manifest.path), manifest };
}

export function withDirectorContactSheets(cli, prepare) {
  return { ...cli, director: async (input, output, options) => {
    const sheets = await prepare(input);
    if (JSON.stringify(sheets.source_frames) !== JSON.stringify(input.frames)
      || JSON.stringify(sheets.frames.flatMap(row => row.source_frame_ids)) !== JSON.stringify(input.frames.map(row => row.id)))
      throw new Error('contact_sheet_complete_frame_mapping_required');
    return cli.director({ ...input, frames: sheets.frames, data: { ...input.data, source_frames: input.frames,
      frame_sheet_layout: sheets.layout, frame_sheet_layout_version: sheets.layout_version ?? 'fixed-3x2-v1',
      frame_sheet_manifest: sheets.manifest } }, output, options);
  } };
}

export function withMaterialContactSheets(cli, prepare) {
  return { ...cli, materialSelector: async (input, output, options) => {
    if (!input.frames?.length) return cli.materialSelector(input, output, options);
    const originals = input.frames.map((frame, index) => ({ ...frame, id: `case-frame-${index + 1}` }));
    const frames = [], manifests = [];
    for (const id of new Set(originals.flatMap(frame => frame.case_ids ?? []))) {
      const group = originals.filter(frame => frame.case_ids.includes(id));
      const sheets = await prepare({ frames: group }, id, output);
      if (JSON.stringify(sheets.source_frames) !== JSON.stringify(group)
        || JSON.stringify(sheets.frames.flatMap(row => row.source_frame_ids)) !== JSON.stringify(group.map(row => row.id)))
        throw new Error('material_sheet_complete_frame_mapping_required');
      await verifyEvidenceBindings([sheets.manifest, sheets.frames, group]);
      frames.push(...sheets.frames.map(frame => ({ ...frame, case_ids: [id] })));
      manifests.push({ ...sheets.manifest, case_ids: [id], layout: sheets.layout });
    }
    return cli.materialSelector({ ...input, frames, source_frames: originals,
      frame_sheet_manifests: manifests }, output, options);
  } };
}

export async function runCorpusBatch(config, runtime = {}) {
  if (config.prefer_vertical !== undefined && typeof config.prefer_vertical !== 'boolean') throw new Error('prefer_vertical_boolean_required');
  if (config.prefer_vertical === true && !config.source_format_manifest) throw new Error('source_format_binding_required');
  const checkpointRoot = path.resolve(config.checkpoint_root), permanentRoot = path.resolve(config.permanent_root);
  if (checkpointRoot === permanentRoot) throw new Error('permanent_and_checkpoint_roots_must_differ');
  await mkdir(checkpointRoot, { recursive: true }); await mkdir(permanentRoot, { recursive: true });
  const document = await readJson(config.manifest_file);
  const catalog = await readJson(config.catalog_manifest), catalogWorks = new Map((catalog.works ?? []).map(row => [row.work_id, row]));
  const candidateDocument = config.candidate_manifest ? await readJson(config.candidate_manifest) : null;
  const plan = planCorpusBatch(document, { ...config, prefer_vertical: false }, candidateDocument);
  const templates = Object.fromEntries(await Promise.all(backends.map(async name => [name, await readJson(config.model_configs[name])])));
  const modelIdentity = Object.fromEntries(backends.map(name => [name, Object.fromEntries(Object.entries(templates[name])
    .filter(([key]) => !['jobs', 'output_dir', 'array_dir'].includes(key)))]));
  const identity = { manifest_sha256: await hashFile(config.manifest_file), catalog_sha256: await hashFile(config.catalog_manifest),
    candidate_manifest_sha256: config.candidate_manifest ? await hashFile(config.candidate_manifest) : null,
    library_sha256: config.library_db ? await hashFile(config.library_db) : null,
    permanent_root: permanentRoot, models: modelIdentity,
    cli: semanticCli(config.cli),
    director_contact_sheet_tool: await hashFile(path.join(here, 'prepare_director_contact_sheets.py')),
    pilot_work_id: config.pilot_work_id };
  const stateFile = path.join(checkpointRoot, 'batch-state.json');
  let state;
  const lockFile = path.join(checkpointRoot, 'batch.lock');
  const releaseLock = await acquireBatchLock(lockFile);
  const saveGate = gate(), gpuGate = gate(), summaryGate = gate(), identityGate = gate();
  const save = () => saveGate(async () => {
    state.revisions++; state.updated_at = new Date().toISOString();
    const data = JSON.stringify(state, null, 2) + '\n';
    await writeFile(stateFile + '.tmp', data); await rename(stateFile + '.tmp', stateFile);
  });
  let paused = false, draining = false, drainOrigin = null;
  const signalDrain = signal => {
    draining = true;
    drainOrigin = { kind: 'signal', signal, received_at: new Date().toISOString(), pid: process.pid };
  };
  const interruptDrain = () => signalDrain('SIGINT'), terminateDrain = () => signalDrain('SIGTERM');
  process.on('SIGINT', interruptDrain); process.on('SIGTERM', terminateDrain);
  const stopRequested = async () => {
    if (!draining && ((runtime.shouldStop && await runtime.shouldStop())
      || await exists(config.stop_request_file ?? path.join(checkpointRoot, 'stop-request.json')))) draining = true;
    return draining;
  };
  const checkStorage = () => (runtime.checkStorage ?? storageCheck)(checkpointRoot);
  const progress = async (entry, status) => { runtime.onProgress?.({ episode_id: entry.episode_id, work_id: entry.work_id, status }); await save(); };

  const sourceIdentityEligible = (entry, item) => identityGate(async () => {
    const file = path.join(checkpointRoot, 'source-identity-disputes.json');
    let snapshot = null, row = null, reason = null, absent = false;
    try {
      let bytes;
      try { bytes = await readFile(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; absent = true; }
      if (!absent) {
        const sha256 = shaBytes(bytes), snapshotFile = path.join(checkpointRoot, 'source-identity-reviews', `${sha256}.json`);
        await mkdir(path.dirname(snapshotFile), { recursive: true });
        try { await writeFile(snapshotFile, bytes, { flag: 'wx' }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (await hashFile(snapshotFile) !== sha256) throw new Error('identity_sidecar_snapshot_changed');
        snapshot = { path: snapshotFile, sha256 };
        const sidecar = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
        if (sidecar.schema_version !== 1 || sidecar.kind !== 'source_identity_dispute_sidecar' || !Array.isArray(sidecar.entries))
          throw new Error('identity_sidecar_invalid');
        const ids = new Set();
        for (const candidate of sidecar.entries) {
          if (!candidate?.episode_id || ids.has(candidate.episode_id) || !/^[a-f0-9]{64}$/.test(candidate.source_video_sha256 ?? ''))
            throw new Error('identity_sidecar_invalid');
          ids.add(candidate.episode_id);
        }
        row = sidecar.entries.find(candidate => candidate.episode_id === entry.episode_id);
        if (row) {
          if (row.source_video_sha256 !== entry.sha256 || row.work_id !== entry.work_id) reason = 'identity_sidecar_source_conflict';
          else if (row.identity_status === 'disputed' && row.current_research_input_eligible === false) reason = 'source_identity_disputed';
          else if (row.identity_status !== 'resolved' || row.current_research_input_eligible !== true) reason = 'identity_sidecar_status_unknown';
          else {
            const resolution = row.resolution;
            if (resolution?.source_video_sha256 !== entry.sha256 || !resolution.reason?.trim()
              || !Array.isArray(resolution.evidence_files) || !resolution.evidence_files.length)
              reason = 'identity_resolution_evidence_required';
            else for (const evidence of resolution.evidence_files) {
              if (!evidence?.path || !/^[a-f0-9]{64}$/.test(evidence.sha256 ?? '') || !await unchanged(evidence)) {
                reason = 'identity_resolution_evidence_changed'; break;
              }
            }
          }
          if (reason) item.identity_dispute_requires_resolution = true;
        }
      }
      if (!row && item.identity_dispute_requires_resolution) reason = 'identity_resolution_missing';
    } catch (error) {
      if (row) item.identity_dispute_requires_resolution = true;
      reason = ['identity_sidecar_invalid', 'identity_sidecar_snapshot_changed'].includes(error.message)
        ? error.message : 'identity_sidecar_read_or_evidence_error';
    }
    if (absent && !item.identity_review && !reason) return true;
    const review = { source_sha256: entry.sha256, sidecar: snapshot, live_sidecar_path: file,
      status: reason ? 'identity_disputed' : row ? 'resolved' : 'not_listed', reason,
      requires_explicit_resolution: item.identity_dispute_requires_resolution === true && !!reason };
    if (canonical(item.identity_review) !== canonical(review)) {
      if (item.identity_review) (item.identity_review_history ??= []).push(item.identity_review);
      item.identity_review = review;
    }
    if (reason) {
      if (item.status !== 'identity_disputed') item.identity_resume_status = item.status;
      item.status = 'identity_disputed';
    } else {
      item.identity_dispute_requires_resolution = false;
      if (item.status === 'identity_disputed') item.status = item.identity_resume_status ?? 'pending';
      delete item.identity_resume_status;
    }
    await save();
    return !reason;
  });

  async function workIdentityEligible(workId, entries) {
    let eligible = true;
    for (const entry of entries) if (!await sourceIdentityEligible(entry, state.episodes[entry.episode_id])) eligible = false;
    const saved = state.works[workId];
    if (!eligible) {
      const work = state.works[workId] ??= {};
      work.identity_resume_state ??= { status: work.status ?? null, error: work.error ?? null };
      work.status = 'aggregation_gap'; work.error = 'source_identity_disputed'; await save();
    } else if (saved?.identity_resume_state) {
      Object.assign(saved, saved.identity_resume_state); delete saved.identity_resume_state; await save();
    }
    return eligible;
  }

  async function prepareObservation(entry, item, root) {
      if (paused || await stopRequested()) return null;
      if (!await sourceIdentityEligible(entry, item)) return null;
      const started = performance.now(), timing = { started_at: new Date().toISOString(), source_sha256: entry.sha256,
        preparation_executed: false, window_inputs_executed: 0 };
      (item.preparation_runs ??= []).push(timing);
      try {
      await checkStorage();
      if (await hashFile(entry.video) !== entry.sha256) throw new Error('batch_source_hash_mismatch');
      item.preparations ??= [];
      let prepared = item.preparations.find(row => row.manifest);
      if (prepared && await hashFile(prepared.manifest.path) !== prepared.manifest.sha256) throw new Error('prepared_manifest_changed');
      if (prepared && JSON.stringify(await bindPreparedEpisode(prepared.manifest.path)) !== JSON.stringify(prepared.binding))
        throw new Error('prepared_media_evidence_changed');
      while (!prepared && item.preparations.length < 2) {
        if (paused || await stopRequested()) return null;
        const attempt = { directory: path.join(root, 'preparation', String(item.preparations.length + 1)), status: 'running' };
        item.preparations.push(attempt); item.status = 'preparing'; await progress(entry, item.status);
        try {
          timing.preparation_executed = true;
          await (runtime.prepareEpisode ?? prepareEpisode)({ video: entry.video, out: attempt.directory, step: 2 });
          attempt.manifest = await binding(path.join(attempt.directory, 'manifest.json'));
          attempt.binding = await bindPreparedEpisode(attempt.manifest.path); attempt.status = 'complete'; prepared = attempt;
        } catch (error) { attempt.status = 'failed'; attempt.error = errorCode(error); attempt.repair = 'next_attempt_uses_new_empty_directory'; }
        await save();
      }
      if (!prepared) throw new Error('preparation_failed_exhausted');
      const manifest = await readJson(prepared.manifest.path);
      if (manifest.source_sha256 !== entry.sha256) throw new Error('prepared_source_hash_mismatch');
      const audio = path.resolve(path.dirname(prepared.manifest.path), manifest.original_audio), audioSha = await hashFile(audio);
      item.windows ??= [];
      const ranges = windowsFor(manifest.timeline.duration_samples / manifest.timeline.sample_rate), jobs = [];
      for (const [index, source_range] of ranges.entries()) {
        const saved = item.windows[index], input = path.join(root, 'inputs', `window-${index + 1}.wav`);
        if (saved) {
          if (JSON.stringify(saved.source_window_seconds) !== JSON.stringify(source_range)
            || saved.source_sha256 !== entry.sha256 || await hashFile(saved.input_file) !== saved.input_sha256)
            throw new Error('prepared_window_evidence_changed');
          jobs.push(saved); continue;
        }
        await mkdir(path.dirname(input), { recursive: true });
        item.input_attempts ??= {};
        const attempts = item.input_attempts[index] ??= [];
        let actual;
        while (!actual && attempts.length < 2) {
          if (paused || await stopRequested()) return null;
          const attempt = { path: input.replace('.wav', `-attempt-${attempts.length + 1}.wav`), status: 'running' };
          attempts.push(attempt); await save();
          try {
            timing.window_inputs_executed++;
            actual = await (runtime.prepareApiAudio ?? prepareApiAudio)({ path: audio, source_sha256: audioSha,
              source_video_sha256: entry.sha256, source_range, asset_id: 'reference-original', segment_id: `${entry.episode_id}/${index + 1}` }, attempt.path);
            attempt.status = 'complete';
          } catch (error) { attempt.status = 'failed'; attempt.error = errorCode(error); }
          await save();
        }
        if (!actual) throw new Error('audio_input_failed_exhausted');
        const job = { id: `w${String(index + 1).padStart(4, '0')}`, source_file: entry.video, source_sha256: entry.sha256,
          source_window_seconds: source_range, input_file: actual.input_audio.path, input_sha256: actual.input_audio.sha256 };
        item.windows.push(job); jobs.push(job); await save();
      }
      return { jobs, prepared };
      } finally {
        timing.finished_at = new Date().toISOString(); timing.elapsed_ms = performance.now() - started;
        await save();
      }
  }

  async function observe(entry, item, root) {
    const preparation = await prepareObservation(entry, item, root);
    if (!preparation) return null;
    const { jobs, prepared } = preparation;
    const receipts = await gpuGate(async () => {
      if (paused || await stopRequested()) return null;
      if (!await sourceIdentityEligible(entry, item)) return null;
      await checkStorage();
      item.specialists ??= {};
      const receipts = [];
      for (const backend of backends) {
        const attempts = item.specialists[backend] ??= [];
        const completed = new Set();
        for (let index = 0; index < 2; index++) {
          let attempt = attempts[index];
          if (attempt?.status === 'running' && attempt.pid && isAlive(attempt.pid) && !await exists(attempt.receipt_file))
            throw Object.assign(new Error('specialist_process_wait'), { code: 'specialist_process_wait' });
          if (!attempt) {
            const pending = jobs.filter(job => !completed.has(job.id));
            if (!pending.length) break;
            if (paused || await stopRequested()) return null;
            if (!await sourceIdentityEligible(entry, item)) return null;
            const directory = path.join(root, 'specialists', backend, String(index + 1));
            const configFile = path.join(directory, 'config.json'), receiptFile = path.join(directory, 'run', 'receipt.json');
            await mkdir(directory, { recursive: true });
            await saveJson(configFile, { ...templates[backend], jobs: pending, output_dir: path.dirname(receiptFile),
              array_dir: path.join(directory, 'arrays') });
            attempt = { config: await binding(configFile), receipt_file: receiptFile, status: 'running',
              repair: index ? 'retry_only_failed_or_missing_windows_in_new_output' : null };
            attempts.push(attempt); await save();
            try { await (runtime.runSpecialist ?? runSpecialist)(configFile, { python: config.specialist_python,
              environment: config.specialist_environment ?? {}, stdout: path.join(directory, 'stdout.log'), stderr: path.join(directory, 'stderr.log'),
              onSpawn: pid => { attempt.pid = pid; return save(); } }); }
            catch (error) { attempt.error = errorCode(error); }
          }
          if (await exists(attempt.receipt_file)) {
            const run = await readJson(attempt.receipt_file);
            if (run.backend === backend && run.status === 'completed_unqualified' && run.qualified === false) {
              const receipt = await binding(attempt.receipt_file);
              if (attempt.receipt && attempt.receipt.sha256 !== receipt.sha256) throw new Error('specialist_receipt_changed');
              attempt.receipt = receipt; receipts.push(receipt);
              for (const job of run.jobs ?? []) if (job.status === 'predicted') completed.add(job.id);
            }
          }
          attempt.status = completed.size === jobs.length ? 'complete' : 'incomplete'; await save();
          if (completed.size === jobs.length) break;
        }
        if (completed.size !== jobs.length) throw new Error(`specialist_windows_incomplete:${backend}`);
      }
      return receipts;
    });
    if (!receipts) return null;
    const observer = await (runtime.createObserver ?? createSpecialistResearchObserver)({ receipts, requiredBackends: backends });
    item.status = 'observed_research'; item.observation_receipts = receipts; await progress(entry, item.status);
    return { observer, prepared: prepared.binding };
  }

  async function processEntry(entry, observed = null, prepareOnly = false, onDirectorStart = null) {
    const key = keyFor(entry.episode_id), root = path.join(permanentRoot, entry.split, keyFor(entry.work_id), key);
    const item = state.episodes[entry.episode_id] ??= { work_id: entry.work_id, source_sha256: entry.sha256,
      split: entry.split, root, status: 'pending' };
    try {
      if (item.source_sha256 !== entry.sha256) throw new Error('batch_episode_source_changed');
      if (!await sourceIdentityEligible(entry, item)) return;
      if (terminal.has(item.status)) {
        if (item.status !== 'failed_exhausted' && (!await unchanged(item.result) || !await unchanged(item.case_import)
          || await hashFile(entry.video) !== entry.sha256)) throw new Error('completed_episode_evidence_changed');
        if (item.status !== 'failed_exhausted' && incompleteEpisodeCoverage((await readJson(item.result.path)).coverage))
          throw new Error('completed_episode_coverage_incomplete');
        return;
      }
      observed ??= await observe(entry, item, root);
      if (!observed || paused || await stopRequested()) {
        // This call has returned; natural drain preserves closed preparation without claiming an active task.
        if (draining && item.status === 'preparing') { item.status = 'preparation_drained'; await progress(entry, item.status); }
        return;
      }
      if (prepareOnly) return observed;
      if (!await sourceIdentityEligible(entry, item)) return;
      await checkStorage();
      const recoverySuffix = item.active_recovery_id ? ['recoveries', item.active_recovery_id] : [];
      const priorRecovery = item.recovery_history?.find(row => row.recovery_id === item.active_recovery_id)?.prior_recovery_id;
      const priorSuffix = priorRecovery ? ['recoveries', priorRecovery] : [];
      const rawCli = await makeRuntime(config, { stateDirectory: path.join(checkpointRoot, 'cli', key, ...recoverySuffix),
        archiveDirectory: path.join(root, 'cli', ...recoverySuffix),
        ...(recoverySuffix.length ? { reuseStateDirectory: path.join(checkpointRoot, 'cli', key, ...priorSuffix),
          reuseArchiveDirectory: path.join(root, 'cli', ...priorSuffix) } : {}),
        mediaBindings: [{ path: entry.video, sha256: entry.sha256 }] }, runtime);
      const cli = withDirectorContactSheets(rawCli, input => (runtime.prepareContactSheets ?? prepareDirectorSheets)(input,
        path.join(root, 'director-contact-sheets', 'aspect-v2', shaBytes(JSON.stringify(input.frames)).slice(0, 20)), config.contact_sheet_python ?? config.python));
      item.status = 'directing'; await progress(entry, item.status);
      onDirectorStart?.();
      const work = catalogWorks.get(entry.work_id), platformIdentities = document.entries.filter(row => row.work_id === entry.work_id);
      const identityAliases = [...new Set([work?.group_id, work?.series_group_id,
        ...platformIdentities.map(row => row.platform && row.official_series_id ? `${row.platform}:${row.official_series_id}` : null)].filter(Boolean))];
      const result = await (runtime.distillEpisode ?? distillEpisode)({ mode: 'research', video: entry.video, work_id: entry.work_id,
        episode_id: entry.episode_id, title: entry.title, split: entry.split,
        official_series_id: work?.official_series_ids?.hongguo ?? entry.official_series_id, identity_aliases: identityAliases,
        official_source: entry.official_source, source_version: entry.source_version, source_video_sha256: entry.sha256,
        model_bindings: { director_frame_presentation: 'contact-sheets-aspect-v2-bounded-v1' },
        prepared_manifest_binding: observed.prepared, output_dir: path.join(root, 'distillation'),
        checkpoint_dir: path.join(checkpointRoot, 'episodes', key) }, {
        ...cli, observer: observed.observer, observer_backend_id: observed.observer.backend_id,
        observer_model_revision: observed.observer.model_revision,
      });
      if (result.status === 'research_processed') clearResolvedError(item);
      const resultPath = path.join(root, `result-${state.revisions}.json`); await saveJson(resultPath, result);
      item.result = await binding(resultPath); item.case_import_file = result.case_import_file ?? null;
      item.case_import = item.case_import_file ? await binding(item.case_import_file) : null; item.coverage = result.coverage;
      item.cli_receipts = result.cli_receipts ?? []; item.cli_model_calls = result.cli_model_calls ?? 0;
      item.confirmed_catalogue_episode = entry.confirmed_catalogue_episode === true;
      item.counts_toward_screenshot_coverage = entry.confirmed_catalogue_episode === true;
      if (quota(result.status) || quota(result.error)) throw Object.assign(new Error('account_quota_wait'), { code: 'account_quota_wait' });
      if (slotAttention(result.status) || slotAttention(result.error))
        throw Object.assign(new Error('account_cli_slots_needs_attention'), { code: 'account_cli_slots_needs_attention' });
      if (authorization(result.status) || authorization(result.error))
        throw Object.assign(new Error('codex_cli_authorization_paused'), { code: 'codex_cli_authorization_paused' });
      item.status = result.status === 'research_processed' ? (entry.split === 'heldout' ? 'heldout_processed' : 'research_processed') : 'failed_exhausted';
      item.gaps = result.gaps ?? []; if (result.error) item.error = result.error;
    } catch (error) {
      item.error = errorCode(error); item.error_receipt = error.receipt_file ?? null;
      if (!item.error_receipt) {
        // Preserve filesystem diagnostics without copying stderr, prompts or credentials.
        const file = path.join(root, 'failures', `${Date.now()}-${randomUUID()}.json`);
        await saveJson(file, { schema_version: 1, kind: 'episode_execution_failure', episode_id: entry.episode_id,
          source_video_sha256: entry.sha256, occurred_at: new Date().toISOString(), stage: item.status,
          recovery_id: item.active_recovery_id ?? null, error_code: item.error,
          storage_reason: error.code === 'storage_paused' ? error.message : null,
          storage_observation: error.storage_observation ?? null,
          syscall: typeof error.syscall === 'string' ? error.syscall : null,
          filesystem_path: typeof error.path === 'string' && path.isAbsolute(error.path) ? error.path : null,
          stack: [item.error, ...(error.stack?.split(/\r?\n/).slice(1).filter(line => /^\s+at /.test(line)).slice(0, 20) ?? [])],
          qualified: false, previous_results_preserved: true });
        item.error_receipt = file;
      }
      item.cli_receipts = error.cli_receipts ?? item.cli_receipts ?? [];
      if (quota(item.error)) { item.status = 'quota_paused'; state.status = 'quota_paused'; paused = true; }
      else if (authorization(item.error)) { item.status = 'authorization_paused'; state.status = 'authorization_paused'; paused = true; }
      else if (slotAttention(item.error)) { item.status = 'needs_attention'; state.status = 'needs_attention'; state.error = 'account_cli_slots_needs_attention'; paused = true; }
      else if (['storage_paused', 'specialist_process_wait'].includes(error.code)) { item.status = error.code; state.status = error.code; paused = true; }
      else item.status = 'failed_exhausted';
    }
    await progress(entry, item.status);
  }

  async function finalizeWork(workId) {
    // Do not queue an incomplete work behind a long material/Nuwa operation.
    if (!plan.inputs.filter(row => row.work_id === workId).every(row => terminal.has(state.episodes[row.episode_id]?.status))) return;
    return summaryGate(async () => {
      if (paused || await stopRequested()) return;
      // Scheduling preference must not change episode order or the work signature.
      const entries = plan.inputs.filter(row => row.work_id === workId).toSorted((a, b) =>
        String(a.platform).localeCompare(String(b.platform))
        || String(a.platform_series_id ?? a.official_series_id).localeCompare(String(b.platform_series_id ?? b.official_series_id))
        || a.episode_number - b.episode_number || a.source_version.localeCompare(b.source_version));
      if (!entries.every(row => terminal.has(state.episodes[row.episode_id]?.status))) return;
      if (!await workIdentityEligible(workId, entries)) return;
      if (entries.some(row => state.episodes[row.episode_id].error === 'completed_episode_coverage_incomplete')) {
        state.works[workId] = { ...state.works[workId], status: 'aggregation_gap', error: 'completed_episode_coverage_incomplete' };
        await save(); return;
      }
      if (entries[0].split === 'heldout') {
        state.works[workId] = { status: 'heldout_director_results_isolated', episode_ids: entries.map(row => row.episode_id),
          rule_synthesis_performed: false, material_retrieval_performed: false }; await save(); return;
      }
      const inputs = entries.filter(row => state.episodes[row.episode_id].status === 'research_processed')
        .map(row => state.episodes[row.episode_id].case_import_file).filter(Boolean);
      if (!inputs.length) { state.works[workId] = { status: 'no_cases_failed_episodes_retained' }; await save(); return; }
      const files = await Promise.all(inputs.map(binding)), signature = shaBytes(JSON.stringify(files));
      const root = path.join(permanentRoot, 'work-results', keyFor(workId), signature.slice(0, 16));
      const cli = await makeRuntime(config, { stateDirectory: path.join(checkpointRoot, 'work-cli', keyFor(workId)),
        archiveDirectory: path.join(root, 'cli'), mediaBindings: entries.map(row => ({ path: row.video, sha256: row.sha256 })) }, runtime);
      // An offline retrieval can be long; recheck drain before its next model stage.
      for (const role of ['synthesizer', 'materialSelector']) {
        const invoke = cli[role];
        if (typeof invoke === 'function') cli[role] = async (...args) => {
          if (await stopRequested()) throw Object.assign(new Error('aggregation_drained'), { code: 'aggregation_drained' });
          return invoke(...args);
        };
      }
      const materialPipeline = { version: 'observed-candidate-selection-v1',
        rule_evidence_compiler_revision: RULE_EVIDENCE_COMPILER_REVISION,
        selector_present: typeof cli.materialSelector === 'function', selector_backend_id: cli.materialSelector_backend_id ?? null,
        selector_model_revision: cli.materialSelector_model_revision ?? null,
        observer_present: typeof cli.materialObserver === 'function', observer_backend_id: cli.materialObserver_backend_id ?? null,
        observer_model_revision: cli.materialObserver_model_revision ?? null };
      const materialPipelineSignature = shaBytes(canonical(materialPipeline));
      let saved = state.works[workId];
      if (saved?.signature === signature && saved.status === 'research_aggregated') {
        if (!await unchanged(saved.material_tasks) || !await unchanged(saved.result_binding)) {
          saved.status = 'aggregation_gap'; saved.error = 'work_result_evidence_changed'; await save();
          return;
        }
        if (saved.material_pipeline_signature === materialPipelineSignature) return;
        saved.material_pipeline_history ??= [];
        saved.material_pipeline_history.push({ signature: saved.material_pipeline_signature ?? null,
          result_binding: saved.result_binding, resumed_at: new Date().toISOString() });
      }
      await mkdir(root, { recursive: true });
      if (saved?.signature && saved.signature !== signature) {
        state.work_history ??= {}; state.work_history[workId] ??= [];
        state.work_history[workId].push({ signature: saved.signature, status: saved.status, inputs: saved.inputs,
          material_tasks: saved.material_tasks, result_binding: saved.result_binding, acceptance: saved.acceptance });
      }
      saved = state.works[workId] = { ...(saved?.signature === signature ? saved : {}), signature, status: 'aggregating', inputs: files }; await save();
      try {
        await checkStorage();
        const documents = await Promise.all(inputs.map(readJson)), tasksFile = path.join(root, 'material-tasks.json');
        const cases = documents.flatMap(doc => doc.cases), validateValue = value => validateMaterialPlan(value, cases);
        let tasks;
        if (await exists(tasksFile)) {
          if (saved.material_tasks && !await unchanged(saved.material_tasks)) throw new Error('material_tasks_evidence_changed');
          tasks = await readJson(tasksFile); validateValue(tasks);
        }
        else {
          if (typeof cli.materialPlanner !== 'function') throw new Error('material_planner_runtime_required');
          if (!await workIdentityEligible(workId, entries)) return;
          const response = await cli.materialPlanner({ stage: 'material_task_planning', schema: materialSchema,
            prompt: materialPlanPrompt,
            data: { case_imports: files, cases, source_video_sha256: null } }, root, { validateValue });
          tasks = response.value; validateValue(tasks); await saveJson(tasksFile, tasks);
          saved.material_planner_receipts = response.cli_receipts ?? []; saved.material_planner_response = response.raw_response;
          saved.material_tasks = await binding(tasksFile);
          await save();
        }
        const materialInputs = [];
        for (const [index, doc] of documents.entries()) {
          const ids = new Set(doc.cases.map(row => row.case_id));
          const selected = tasks.tasks.filter(task => ids.has(task.case_id)).map(task => ({ ...task,
            query: { ...task.query, limit: 20, usage_scope: 'research_noncommercial' } }));
          const file = path.join(root, `material-tasks-${index + 1}.json`); await saveJson(file, { schema_version: 1, tasks: selected, gaps: tasks.gaps });
          if (config.library_db && selected.length) materialInputs.push({ input: inputs[index], tasks: file });
        }
        if (await stopRequested()) { saved.status = 'aggregation_drained'; await save(); return; }
        if (!await workIdentityEligible(workId, entries)) return;
        const result = await (runtime.distillCorpus ?? distillCorpus)({ schema_version: 1, mode: 'research', python: config.python,
          output_dir: path.join(checkpointRoot, 'work-corpus', keyFor(workId), signature.slice(0, 16)), artifact_dir: path.join(root, 'corpus'),
          catalog_manifest: config.catalog_manifest, case_import_files: inputs, library_db: config.library_db,
          material_candidate_inputs: materialInputs }, cli);
        const selectionQuota = (result.material_selection_results ?? []).filter(row => quota(row.status) || quota(row.error));
        const quotaWaiting = selectionQuota.length > 0 || quota(result.rule_synthesis?.error) || quota(result.rule_synthesis?.status);
        const slotWaiting = (result.material_selection_results ?? []).some(row => slotAttention(row.status) || slotAttention(row.error))
          || slotAttention(result.rule_synthesis?.error) || slotAttention(result.rule_synthesis?.status);
        const authWaiting = (result.material_selection_results ?? []).some(row => authorization(row.status) || authorization(row.error))
          || authorization(result.rule_synthesis?.error) || authorization(result.rule_synthesis?.status);
        if (result.rule_synthesis?.nuwa_synthesis_completed === true && !quotaWaiting && !slotWaiting && !authWaiting) clearResolvedError(saved);
        saved.status = quotaWaiting ? 'quota_paused' : 'research_aggregated';
        if (selectionQuota.length) {
          saved.error = 'account_quota_wait';
          saved.cli_receipts = selectionQuota.flatMap(row => row.cli_receipts ?? []);
        }
        saved.material_tasks = await binding(tasksFile); saved.result = result;
        saved.material_pipeline_signature = materialPipelineSignature; saved.material_pipeline = materialPipeline;
        const resultFile = path.join(root, `corpus-result-${state.revisions}.json`); await saveJson(resultFile, result);
        saved.result_binding = await binding(resultFile);
        if (await stopRequested()) { saved.status = 'aggregation_drained'; await save(); return; }
        if (slotWaiting) throw Object.assign(new Error('account_cli_slots_needs_attention'), { code: 'account_cli_slots_needs_attention' });
        if (authWaiting) throw Object.assign(new Error('codex_cli_authorization_paused'), { code: 'codex_cli_authorization_paused' });
        saved.acceptance = { nuwa_completed: result.rule_synthesis?.nuwa_synthesis_completed === true,
          material_tasks: tasks.tasks.length, candidate_retrieval_completed: materialInputs.length > 0
            && result.material_candidate_results?.length === materialInputs.length
            && result.material_candidate_results.every(row => row.evidence_binding_currently_valid === true)
            && result.material_candidate_results.reduce((sum, row) => sum + (row.candidate_count ?? 0), 0) > 0,
          material_gaps: tasks.gaps };
        if (saved.status === 'quota_paused') { paused = true; state.status = 'quota_paused'; }
      } catch (error) {
        saved.error = errorCode(error); saved.error_receipt = error.receipt_file ?? null;
        saved.cli_receipts = error.cli_receipts ?? saved.cli_receipts ?? [];
        saved.status = slotAttention(saved.error) ? 'needs_attention' : authorization(saved.error) ? 'authorization_paused'
          : quota(saved.error) ? 'quota_paused' : error.code === 'storage_paused' ? 'storage_paused' : 'aggregation_gap';
        if (['needs_attention', 'authorization_paused', 'quota_paused', 'storage_paused'].includes(saved.status)) {
          paused = true; state.status = saved.status;
          if (saved.status === 'needs_attention') state.error = 'account_cli_slots_needs_attention';
        }
      }
      await save();
    });
  }

  try {
    state = await exists(stateFile) ? await readJson(stateFile) : { schema_version: 1, identity, episodes: {}, works: {}, revisions: 0 };
    if (state.status === 'needs_attention' && slotAttention(state.error))
      return { status: 'needs_attention', error: state.error, checkpoint: stateFile };
    const accountAttentionFile = path.join(config.account_cli_slot_directory ?? path.join(checkpointRoot, 'account-cli-slots'), 'needs-attention.json');
    if (await exists(accountAttentionFile)) {
      state.status = 'needs_attention'; state.error = 'account_cli_slots_needs_attention';
      state.operational_attention_evidence = await binding(accountAttentionFile); await save();
      return { status: state.status, error: state.error, checkpoint: stateFile };
    }
    const canceled = await validateWorkCancellationRecovery(config.work_cancellation_recovery, state,
      config.account_cli_slot_directory ?? path.join(checkpointRoot, 'account-cli-slots'));
    if (canceled) {
      state.work_cancellation_recoveries ??= []; state.work_cancellation_recoveries.push(canceled);
      state.works[canceled.work_id].status = 'aggregation_canceled_before_invocation';
      await save();
    }
    const sourceFormats = config.source_format_manifest ? await validateSourceFormatManifest(config.source_format_manifest, plan.inputs) : null;
    plan.inputs = planCorpusBatch(document, config, candidateDocument, sourceFormats?.entries).inputs;
    if (canonical(state.identity) !== canonical(identity)) {
      const upgrade = config.engineering_upgrade;
      const before = { ...state.identity, director_contact_sheet_tool: identity.director_contact_sheet_tool };
      if (upgrade && !config.snapshot_extension_file
        && canonical(before) === canonical(identity)
        && upgrade.prior_contact_sheet_tool_sha256 === state.identity.director_contact_sheet_tool
        && upgrade.next_contact_sheet_tool_sha256 === identity.director_contact_sheet_tool && upgrade.reason?.trim()) {
        state.processing_upgrades ??= [];
        state.processing_upgrades.push({ ...upgrade, applied_at: new Date().toISOString(), prior_identity: state.identity });
        state.identity = identity; await save();
      } else {
      if (config.recovery_operations?.length) throw new Error('snapshot_extension_and_recovery_must_be_separate_runs');
      if (!config.snapshot_extension_file) throw new Error('batch_identity_changed_requires_new_output');
      const extension = await validateSnapshotExtension(config, state, identity, document, candidateDocument, catalog);
      state.snapshot_extensions ??= []; state.snapshot_extensions.push(extension); state.identity = identity;
      await save();
      }
    }
    const verifyEngineeringPilot = async () => {
      for (const row of plan.pilot) {
        const item = state.episodes[row.episode_id];
        if (item && !await sourceIdentityEligible(row, item)) return false;
        if (item?.status !== 'research_processed' || item.coverage?.complete_processed !== true
          || item.coverage.unclassified_ranges?.length !== 0 || !await unchanged(item.result) || !await unchanged(item.case_import)
          || await hashFile(row.video) !== row.sha256) return false;
        if (incompleteEpisodeCoverage((await readJson(item.result.path)).coverage)) {
          item.status = 'failed_exhausted'; item.error = 'completed_episode_coverage_incomplete'; await save(); return false;
        }
      }
      return plan.pilot.length > 0;
    };
    if (config.phase === 'all') {
      if (!await verifyEngineeringPilot()) throw new Error('pilot_acceptance_required_before_all');
      state.engineering_pilot = { status: 'engineering_pilot_ready', episode_ids: plan.pilot.map(row => row.episode_id),
        qualification_granted: false, sound_quality_approved: false };
    }
    const recoveries = await validateEpisodeRecoveries(config.recovery_operations, state, document.entries);
    for (const recovery of recoveries) {
      const item = state.episodes[recovery.episode_id]; item.recovery_history ??= []; item.recovery_history.push(recovery);
      item.active_recovery_id = recovery.recovery_id; item.status = 'pending'; item.error = null; item.error_receipt = null;
    }
    // Validate the opt-in before marking a fresh worker running. Its stable
    // partition remains the final comparator after extension priority.
    const pendingAdded = new Set((state.snapshot_extensions ?? []).flatMap(row => row.added_episode_ids)
      .filter(id => !terminal.has(state.episodes[id]?.status)));
    const pendingAddedInputs = pendingAdded.size ? plan.inputs.toSorted((a, b) => Number(pendingAdded.has(b.episode_id)) - Number(pendingAdded.has(a.episode_id))) : plan.inputs;
    const schedulingPolicy = await loadEpisodeSchedulingPolicy(checkpointRoot, config.catalog_manifest, catalog, config.phase);
    const scheduledInputs = applyEpisodeSchedulingPolicy(pendingAddedInputs, schedulingPolicy, sourceFormats?.entries);
    const schedulingAudit = await createEpisodeSchedulingAudit(checkpointRoot, schedulingPolicy, scheduledInputs, sourceFormats?.entries,
      { phase: config.phase, manifest_sha256: identity.manifest_sha256, already_terminal_episode_ids:
        scheduledInputs.filter(row => terminal.has(state.episodes[row.episode_id]?.status)).map(row => row.episode_id) });
    state.run_invocations ??= [];
    state.run_invocations.push({ started_at: new Date().toISOString(), pid: process.pid, phase: config.phase,
      declared_cli_transport: config.cli?.transport ?? 'codex_default', manifest_sha256: identity.manifest_sha256,
      source_format_manifest: sourceFormats?.binding ?? null, source_format_source_manifest: sourceFormats?.source_manifest ?? null,
      prefer_vertical: config.prefer_vertical === true, source_format_priority_applied: config.phase === 'all' && config.prefer_vertical === true });
    if (schedulingAudit) {
      state.run_invocations.at(-1).episode_scheduling_policy = schedulingPolicy.binding;
      state.run_invocations.at(-1).episode_scheduling_receipt = schedulingAudit.binding;
    }
    state.status = 'running'; state.phase = config.phase;
    state.counts = { manifest_entries: document.entries.length, confirmed_entries: plan.confirmed_count,
      identity_candidates_pending: plan.candidates.length - plan.admitted_candidates.length,
      research_identity_candidates: plan.admitted_candidates.length, heldout_entries: plan.heldout_count, selected_entries: plan.inputs.length };
    await save();
    let next = 0;
    const summaryJobs = [], queuedWorks = new Set();
    const queueSummary = workId => {
      if (config.phase !== 'all' || queuedWorks.has(workId)
        || !plan.inputs.filter(row => row.work_id === workId).every(row => terminal.has(state.episodes[row.episode_id]?.status))) return;
      queuedWorks.add(workId);
      summaryJobs.push(finalizeWork(workId).catch(async error => {
        state.works[workId] = { status: 'aggregation_gap', error: errorCode(error) }; await save();
      }));
    };
    // At most two queued slots (including in-progress preparation) ahead of two directors.
    // Producers own decoding; only observe's actual specialist section owns the GPU gate.
    const ready = [], waiters = new Set(); let producers = 2, directorOrder = 0;
    const changed = () => new Promise(resolve => waiters.add(resolve));
    const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
    const produce = async () => {
      try {
        while (true) {
          while (true) {
            if (paused || await stopRequested()) return;
            if (ready.length < 2) break;
            await changed();
          }
          const order = next++, entry = scheduledInputs[order]; if (!entry) return;
          let resolveReady;
          const slot = { entry, order, ready: new Promise(resolve => { resolveReady = resolve; }) };
          ready.push(slot); wake();
          try {
            if (!terminal.has(state.episodes[entry.episode_id]?.status)) await schedulingAudit?.recordPreparationAdmission(entry);
            slot.observed = await processEntry(entry, null, true);
          }
          catch (error) { slot.error = error; paused = true; throw error; }
          finally { resolveReady(); wake(); }
        }
      } finally { producers--; wake(); }
    };
    const consume = async () => {
      try {
        while (!paused && !await stopRequested()) {
          const slot = ready.shift(); wake();
          if (!slot) { if (!producers) return; await changed(); continue; }
          await slot.ready;
          if (slot.error) throw slot.error;
          // Preserve planned priority when two decoders finish in a different order.
          while (true) {
            if (paused || await stopRequested()) return;
            if (slot.order === directorOrder) break;
            await changed();
          }
          let admitted = false;
          const admitNext = () => { if (!admitted) { admitted = true; directorOrder++; wake(); } };
          try { if (slot.observed) await processEntry(slot.entry, slot.observed, false, admitNext); }
          finally { admitNext(); }
          queueSummary(slot.entry.work_id);
        }
      } catch (error) { paused = true; throw error; }
      finally { wake(); }
    };
    const stages = await Promise.allSettled([produce(), produce(), consume(), consume()]);
    const failure = stages.find(row => row.status === 'rejected');
    if (failure) { await Promise.allSettled(summaryJobs); throw failure.reason; }
    await Promise.all(summaryJobs);
    if (!paused && !draining && config.phase === 'pilot') {
      const passed = await verifyEngineeringPilot();
      state.engineering_pilot = { episode_ids: plan.pilot.map(row => row.episode_id),
        status: passed ? 'engineering_pilot_ready' : 'pilot_incomplete', qualification_granted: false, sound_quality_approved: false };
      state.pilot ??= { episode_ids: plan.pilot.map(row => row.episode_id), status: 'pilot_incomplete' };
      state.status = state.engineering_pilot.status;
    }
    if (!paused && !draining && config.phase === 'all') {
      const accepted = state.works[config.pilot_work_id]?.acceptance;
      state.pilot = { episode_ids: plan.pilot.map(row => row.episode_id),
        status: engineeringPilotReady(state) && accepted?.nuwa_completed === true && accepted.candidate_retrieval_completed === true ? 'pilot_ready' : 'pilot_incomplete' };
      state.sound_material_quality = { nuwa_completed: accepted?.nuwa_completed === true,
        candidate_retrieval_completed: accepted?.candidate_retrieval_completed === true, qualification_granted: false };
      state.status = 'batch_finished_with_gaps';
    }
    if (!paused && draining) { state.status = 'drained'; state.drained_at = new Date().toISOString(); }
    state.drain_origin = draining ? drainOrigin : null;
    state.run_invocations.at(-1).drain_origin = state.drain_origin;
    state.counts.statuses = Object.fromEntries([...new Set(Object.values(state.episodes).map(row => row.status))]
      .map(status => [status, Object.values(state.episodes).filter(row => row.status === status).length]));
    await save();
    const report = { schema_version: 1, status: state.status, phase: state.phase, drain_origin: state.drain_origin, counts: state.counts, pilot: state.pilot,
      engineering_pilot: state.engineering_pilot, sound_material_quality: state.sound_material_quality,
      checkpoint: stateFile, permanent_root: permanentRoot, complete_corpus_claimed: false, qualification_granted: false };
    await saveJson(path.join(permanentRoot, `batch-report-${state.revisions}.json`), report);
    return report;
  } finally {
    process.off('SIGINT', interruptDrain); process.off('SIGTERM', terminateDrain);
    await releaseLock();
  }
}

export async function runCorpusBatchContinuously(config, runtime = {}) {
  const stateFile = path.join(path.resolve(config.checkpoint_root), 'batch-state.json');
  if (await exists(stateFile) && engineeringPilotReady(await readJson(stateFile)))
    return runCorpusBatch({ ...config, phase: 'all' }, runtime);
  const pilot = await runCorpusBatch({ ...config, phase: 'pilot' }, runtime);
  if (pilot.status !== 'engineering_pilot_ready' && pilot.status !== 'pilot_ready') return pilot;
  return runCorpusBatch({ ...config, phase: 'all' }, runtime);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = await readJson(process.argv[2]);
  const run = config.phase === 'continuous' ? runCorpusBatchContinuously : runCorpusBatch;
  const result = await run(config, { onProgress: event => process.stdout.write(JSON.stringify(event) + '\n') });
  process.stdout.write(JSON.stringify(result) + '\n');
}
