import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shaBytes } from './audio_api.mjs';

const policyKeys = new Set(['schema_version', 'kind', 'policy_id', 'catalogue', 'max_episode', 'scope',
  'prefer_vertical', 'tail_policy', 'preserve_split', 'preserve_terminal_and_active_work',
  'grant_full_episode_coverage', 'grant_original_track_identity', 'grant_clean_recording_or_package_quality']);

/** Optional operational scheduling; it never participates in the batch/cache identity. */
export async function loadEpisodeSchedulingPolicy(checkpointRoot, catalogPath, catalog, phase) {
  if (phase !== 'all') return null;
  const policyPath = path.join(checkpointRoot, 'episode-scheduling-policy.json');
  let bytes;
  try { bytes = await readFile(policyPath); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let policy;
  try { policy = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error('episode_scheduling_policy_invalid_json'); }
  if (!policy || Object.keys(policy).some(key => !policyKeys.has(key))
    || policy.schema_version !== 1 || policy.kind !== 'corpus_episode_scheduling_policy'
    || typeof policy.policy_id !== 'string' || !policy.policy_id.trim()
    || !Number.isInteger(policy.max_episode) || policy.max_episode < 1 || policy.max_episode > 10
    || policy.scope !== 'canonical_115_work_ids' || policy.prefer_vertical !== true
    || policy.tail_policy !== 'retain_existing_fullrange_and_extra_hongguo'
    || policy.preserve_split !== true || policy.preserve_terminal_and_active_work !== true
    || policy.grant_full_episode_coverage !== false || policy.grant_original_track_identity !== false
    || policy.grant_clean_recording_or_package_quality !== false
    || !policy.catalogue || Object.keys(policy.catalogue).some(key => !['path', 'sha256'].includes(key))
    || typeof policy.catalogue.path !== 'string' || path.resolve(policy.catalogue.path) !== path.resolve(catalogPath)
    || !/^[a-f0-9]{64}$/.test(policy.catalogue.sha256 ?? '')) throw new Error('episode_scheduling_policy_invalid');
  const catalogBytes = await readFile(catalogPath);
  if (shaBytes(catalogBytes) !== policy.catalogue.sha256) throw new Error('episode_scheduling_catalogue_hash_mismatch');
  const boundCatalog = JSON.parse(catalogBytes.toString('utf8').replace(/^\uFEFF/, ''));
  if (JSON.stringify(boundCatalog) !== JSON.stringify(catalog)) throw new Error('episode_scheduling_catalogue_changed');
  if (catalog.scope_basis !== 'user_screenshot_115' || !Array.isArray(catalog.works) || catalog.works.length !== 115
    || catalog.works.some(row => typeof row.work_id !== 'string' || !row.work_id.trim()
      || !Number.isInteger(row.episode_count) || row.episode_count < 1)
    || new Set(catalog.works.map(row => row.work_id)).size !== 115) throw new Error('episode_scheduling_115_catalogue_required');
  return { policy, bytes, binding: { path: path.resolve(policyPath), sha256: shaBytes(bytes) },
    workEpisodeLimits: new Map(catalog.works.map(row => [row.work_id, Math.min(policy.max_episode, row.episode_count)])) };
}

export function isPriorityEpisode(entry, loaded, sourceFormats) {
  if (!loaded || entry.split !== 'research' || !Number.isInteger(entry.episode_number)
    || entry.episode_number < 1 || entry.episode_number > (loaded.workEpisodeLimits.get(entry.work_id) ?? 0)) return false;
  const format = sourceFormats?.get(entry.episode_id);
  return format?.source_video_sha256 === entry.sha256 && format.orientation === 'vertical';
}

/** Stable partition runs AFTER pendingAdded; all original rows/references survive. */
export function applyEpisodeSchedulingPolicy(inputs, loaded, sourceFormats) {
  if (!loaded) return inputs;
  if (!(sourceFormats instanceof Map) || inputs.some(row => sourceFormats.get(row.episode_id)?.source_video_sha256 !== row.sha256))
    throw new Error('episode_scheduling_verified_source_format_required');
  const priority = row => row.split === 'heldout' ? 2 : isPriorityEpisode(row, loaded, sourceFormats) ? 0 : 1;
  return inputs.toSorted((a, b) => priority(a) - priority(b));
}

export async function createEpisodeSchedulingAudit(checkpointRoot, loaded, inputs, sourceFormats, metadata) {
  if (!loaded) return null;
  const root = path.join(checkpointRoot, 'episode-scheduling-audits', randomUUID());
  await mkdir(root, { recursive: true });
  const snapshotPath = path.join(root, 'policy-snapshot.json');
  await writeFile(snapshotPath, loaded.bytes, { flag: 'wx' });
  const receiptPath = path.join(root, 'scheduling-receipt.json');
  const receipt = { schema_version: 1, kind: 'actual_fresh_worker_episode_scheduling_receipt',
    created_at: new Date().toISOString(), pid: process.pid, ...metadata,
    policy_id: loaded.policy.policy_id, live_policy_binding: loaded.binding,
    policy_snapshot: { path: snapshotPath, sha256: loaded.binding.sha256 }, catalogue: loaded.policy.catalogue,
    priority_applied_to_new_worker_schedule: true, order_policy: 'stable_first10_research_vertical_then_research_remainder_then_isolated_heldout',
    scheduled_episode_ids: inputs.map(row => row.episode_id),
    priority_episode_ids: inputs.filter(row => isPriorityEpisode(row, loaded, sourceFormats)).map(row => row.episode_id),
    actual_priority_preparation_admissions: [],
    fullrange_and_extra_source_rows_retained: true, heldout_split_unchanged: true,
    cache_identity_changed: false, terminal_or_auth_states_reset: false,
    grant_full_episode_coverage: false, grant_original_track_identity: false,
    grant_clean_recording_or_package_quality: false, original_identification_executor_dispatched: false };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
  let writing = Promise.resolve();
  return { binding: { path: receiptPath }, receipt, async recordPreparationAdmission(entry) {
    if (!isPriorityEpisode(entry, loaded, sourceFormats)) return;
    receipt.actual_priority_preparation_admissions.push({ episode_id: entry.episode_id, source_sha256: entry.sha256,
      work_id: entry.work_id, episode_number: entry.episode_number, admitted_at: new Date().toISOString() });
    writing = writing.then(() => writeFile(receiptPath, JSON.stringify(receipt, null, 2) + '\n'));
    await writing;
  } };
}
