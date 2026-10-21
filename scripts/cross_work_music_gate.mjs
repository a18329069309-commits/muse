import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { hashFile, verifyRenderBinding } from './render_binding.mjs';
import { loadProjectTrialPolicy } from './project_trial_gate.mjs';
import { isIndependentMusicPackTrial, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { resolveVerifiedRecordingFamily } from './music_family_identity.mjs';
import { openMusicDeliveryIndex, indexVerifiedMusicDelivery, syncMusicDeliveryIndex, queryRelevantDeliveries } from './music_delivery_index.mjs';
import { listIndependentRenderReservations, isDeadLocalRenderOwner, reserveIndependentRender,
  heartbeatIndependentRender, finishIndependentRender, recoverDeadIndependentRender,
  inspectDeadRenderProcessTree, holdIndependentRenderRecovery } from './music_render_reservations.mjs';

const RATE = 48000;
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = value => /^[a-f0-9]{64}$/.test(value ?? '');
const parse = value => JSON.parse(value.replace(/^\uFEFF/, ''));
const normalized = value => path.resolve(value).replaceAll('\\', '/').toLowerCase();
const samePath = (a, b) => normalized(a) === normalized(b);
const inside = (file, root) => samePath(file, root) || normalized(file).startsWith(`${normalized(root).replace(/\/$/, '')}/`);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = code => { throw Error(code); };
const readContext = (stats = null) => ({ bound: new Map(), identityIndexes: new WeakMap(), families: new Map(),
  recordingIndexes: new Map(), stats });

function union(ranges) {
  const result = [];
  for (const [start, end] of ranges.toSorted((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const previous = result.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else result.push([start, end]);
  }
  return result;
}
const size = ranges => ranges.reduce((sum, [start, end]) => sum + end - start, 0);

export function workFromSourcePath(sourcePath) {
  const title = typeof sourcePath === 'string' ? sourcePath.match(/《([^》]+)》/)?.[1]?.trim().normalize('NFC') : null;
  return title ? { id: `host-title:${title}`, title, basis: 'first_title_in_verified_source_path' } : null;
}

// Inputs are the runner's hashed source and asset bindings, never selected_music self-reports.
export function summarizeActualMusic({ plan, assets, durationSamples, source, work = null, recordingFamilies = null }) {
  if (!hash(source?.sha256) || !path.isAbsolute(source?.path ?? '')
    || !Number.isSafeInteger(durationSamples) || durationSamples <= 0
    || !Array.isArray(plan?.assets) || !Array.isArray(plan?.cues)) fail('cross_work_actual_plan_bindings_required');
  const recordings = new Map(), allRanges = [];
  for (const cue of plan.cues.filter(row => row.track === 'bgm')) {
    const asset = plan.assets.find(row => row.id === cue.asset_id), binding = assets?.[cue.asset_id];
    if (!asset || !hash(binding?.sha256) || asset.sha256 !== undefined && asset.sha256.toLowerCase() !== binding.sha256)
      fail('cross_work_verified_recording_binding_required');
    const sourceIn = cue.source_in_seconds, sourceOut = cue.source_out_seconds;
    if (!finite(sourceIn) || !finite(sourceOut) || sourceIn < 0 || sourceOut <= sourceIn)
      fail('cross_work_actual_recording_range_required');
    const input = Math.round(sourceIn * RATE), end = Math.round(sourceOut * RATE);
    const hasStart = Object.hasOwn(cue, 'start_seconds'), hasSync = Object.hasOwn(cue, 'sync');
    if (hasStart === hasSync) fail('cross_work_actual_target_range_required');
    let start;
    if (hasStart) {
      if (!finite(cue.start_seconds)) fail('cross_work_actual_target_range_required');
      start = Math.round(cue.start_seconds * RATE);
    } else {
      if (!finite(cue.sync?.target_seconds) || !finite(cue.sync?.source_anchor_seconds)
        || cue.sync.source_anchor_seconds < sourceIn || cue.sync.source_anchor_seconds >= sourceOut)
        fail('cross_work_actual_target_range_required');
      start = Math.round(cue.sync.target_seconds * RATE) - (Math.round(cue.sync.source_anchor_seconds * RATE) - input);
    }
    const target = [Math.max(0, start), Math.min(durationSamples, start + end - input)];
    if (target[1] <= target[0] || start + end - input > durationSamples) fail('cross_work_actual_target_range_required');
    const row = recordings.get(binding.sha256) ?? { recording_sha256: binding.sha256, target_ranges_samples: [], cues: [] };
    row.target_ranges_samples.push(target);
    row.cues.push({ cue_id: cue.id, asset_id: cue.asset_id, target_range_samples: target,
      source_range_samples: [input + target[0] - start, input + target[1] - start] });
    recordings.set(binding.sha256, row); allRanges.push(target);
  }
  const rows = [...recordings.values()].map(row => ({ ...row,
    target_ranges_samples: union(row.target_ranges_samples), union_samples: size(union(row.target_ranges_samples)) }))
    .toSorted((a, b) => b.union_samples - a.union_samples || a.recording_sha256.localeCompare(b.recording_sha256));
  const result = { source: { path: source.path, sha256: source.sha256 }, work,
    sample_rate: RATE, duration_samples: durationSamples, total_music_union_samples: size(union(allRanges)),
    recordings: rows, dominant_recording_sha256: rows.filter(row => row.union_samples === rows[0]?.union_samples)
      .map(row => row.recording_sha256) };
  if (recordingFamilies !== null) {
    result.usage_contract_version = 2;
    result.recording_family_by_sha256 = recordingFamilies;
    const ordered = rows.flatMap(row => row.cues.map(cue => ({ recording_sha256: row.recording_sha256,
      family_id: recordingFamilies[row.recording_sha256]?.family_id ?? null,
      source_range_samples: cue.source_range_samples, target_range_samples: cue.target_range_samples })))
      .toSorted((a, b) => a.target_range_samples[0] - b.target_range_samples[0]
        || a.target_range_samples[1] - b.target_range_samples[1] || a.recording_sha256.localeCompare(b.recording_sha256));
    // Splitting a continuous piece cannot disguise a copied arrangement.
    result.ordered_arrangement = [];
    for (const row of ordered) {
      const previous = result.ordered_arrangement.at(-1);
      if (previous && previous.recording_sha256 === row.recording_sha256
        && previous.target_range_samples[1] === row.target_range_samples[0]
        && previous.source_range_samples[1] === row.source_range_samples[0]) {
        previous.target_range_samples[1] = row.target_range_samples[1];
        previous.source_range_samples[1] = row.source_range_samples[1];
      } else result.ordered_arrangement.push(structuredClone(row));
    }
    result.arrangement_fingerprint = sha(JSON.stringify(result.ordered_arrangement.map(row => ({
      // Family membership does not establish the same recording/version clock.
      // Vocal, instrumental and remix variants cannot trigger an exact-copy hold.
      recording: `recording:${row.recording_sha256}`,
      source_range_samples: row.source_range_samples,
      target_relative: row.target_range_samples.map(value => Math.round(value / durationSamples * 1000) / 1000),
    }))));
  }
  return result;
}

// Independent route permits suitable song reuse. Only an actual multi-piece
// arrangement copied into another work is a mechanical-repeat hold; an isolated
// popular song or a title/genre match is never a lifetime exclusion.
export function compareIndependentMusicUsage(current, history, { now = Date.now(), recentDays = 30 } = {}) {
  const conflicts = [], warnings = [], excluded = [], gaps = [];
  if (!current.work?.id) gaps.push('current_work_identity_missing');
  const currentKeys = new Set(current.recordings.map(row => current.recording_family_by_sha256?.[row.recording_sha256]?.family_id
    ? `family:${current.recording_family_by_sha256[row.recording_sha256].family_id}` : `recording:${row.recording_sha256}`));
  const seen = new Set();
  for (const prior of history.toSorted((a, b) => (Date.parse(b.delivered_at ?? '') || 0) - (Date.parse(a.delivered_at ?? '') || 0))) {
    const historyKey = `${prior.source.sha256}:${prior.arrangement_fingerprint ?? 'legacy'}`;
    if (seen.has(historyKey)) continue;
    seen.add(historyKey);
    if (prior.source.sha256 === current.source.sha256 || current.work?.id && prior.work?.id === current.work.id) {
      excluded.push({ source_sha256: prior.source.sha256, work_id: prior.work?.id ?? null,
        reason: prior.source.sha256 === current.source.sha256 ? 'same_source' : 'same_work_reuse_requires_current_plot_selection' });
      continue;
    }
    if (!prior.work?.id) { gaps.push('prior_work_identity_missing'); continue; }
    const shared = prior.recordings.filter(row => currentKeys.has(prior.recording_family_by_sha256?.[row.recording_sha256]?.family_id
      ? `family:${prior.recording_family_by_sha256[row.recording_sha256].family_id}` : `recording:${row.recording_sha256}`));
    const time = Date.parse(prior.delivered_at ?? ''), recent = prior.reservation_state === 'reserved'
      || Number.isFinite(time) && time <= now && time >= now - recentDays * 86400000;
    if (shared.length) warnings.push({ reason: 'song_reuse_requires_current_plot_fit', prior_source_sha256: prior.source.sha256,
      prior_work_id: prior.work.id, shared_recording_sha256: shared.map(row => row.recording_sha256), recent });
    if (recent && current.ordered_arrangement?.length >= 2 && prior.ordered_arrangement?.length >= 2
      && current.arrangement_fingerprint === prior.arrangement_fingerprint)
      conflicts.push({ reason: 'copied_ordered_multi_piece_arrangement', prior_source_sha256: prior.source.sha256,
        prior_work_id: prior.work.id, arrangement_fingerprint: current.arrangement_fingerprint,
        prior_delivery: prior.delivery ?? null, prior_reservation_job_id: prior.reservation_job_id ?? null });
  }
  return { passed: !gaps.length && !conflicts.length,
    status: gaps.length ? 'cross_work_music_identity_gap' : conflicts.length ? 'cross_work_mechanical_arrangement_gap' : 'cross_work_music_passed',
    policy_kind: 'independent_plot_fit_and_recent_arrangement', recent_days: recentDays,
    dominant_song_lifetime_exclusion: false, conflicts, warnings, excluded, gaps: [...new Set(gaps)] };
}

async function independentRecordingFamilies(config, plan, assets, context = readContext()) {
  const binding = config.music_packs?.publication ?? config.music_packs;
  const publication = await boundJson(binding, context);
  if (publication.kind !== 'independent_music_pack_publication' || publication.schema_version !== 1
    || publication.material_strategy !== 'independent_music_packs' || !Array.isArray(publication.packs))
    fail('cross_work_independent_frozen_publication_required');
  let index = context.recordingIndexes.get(binding.sha256);
  if (!index) {
    index = new Map();
    for (const pack of publication.packs) for (const recording of pack.recordings ?? []) {
      const digest = recording.source_sha256 ?? recording.sha256;
      const entries = index.get(digest) ?? [];
      entries.push({ pack, recording }); index.set(digest, entries);
    }
    context.recordingIndexes.set(binding.sha256, index);
  }
  const families = {};
  for (const asset of plan.assets.filter(row => plan.cues.some(cue => cue.track === 'bgm' && cue.asset_id === row.id))) {
    const digest = assets[asset.id]?.sha256;
    const cacheKey = `${binding.sha256}:${digest}`;
    if (context.families.has(cacheKey)) {
      const cached = context.families.get(cacheKey);
      if (cached) families[digest] = cached;
      continue;
    }
    const matches = index.get(digest) ?? [];
    if (!matches.length) fail('cross_work_independent_recording_not_in_frozen_publication');
    const resolved = [];
    for (const { pack, recording } of matches) {
      // Publication was hash checked once for this operation. Proofs remain
      // checked by the helper once per actual recording/frozen publication.
      const verified = await resolveVerifiedRecordingFamily(recording);
      if (verified) resolved.push({ ...verified, pack_id: pack.pack_id, publication_sha256: binding.sha256 });
    }
    if (new Set(resolved.map(row => row.family_id)).size > 1) fail('cross_work_independent_family_conflict');
    context.families.set(cacheKey, resolved[0] ?? null);
    if (resolved.length) families[digest] = resolved[0];
  }
  return families;
}

export function compareDominantMusic(current, history) {
  const conflicts = [], excluded = [], gaps = [];
  if (!current.work?.id) gaps.push('current_work_identity_missing');
  for (const prior of history) {
    if (prior.source.sha256 === current.source.sha256 || current.work?.id && prior.work?.id === current.work.id) {
      excluded.push({ source_sha256: prior.source.sha256, work_id: prior.work?.id ?? null,
        reason: prior.source.sha256 === current.source.sha256 ? 'same_source' : 'same_work_theme_allowed' });
      continue;
    }
    if (!prior.work?.id) { gaps.push('prior_work_identity_missing'); continue; }
    for (const recording of current.dominant_recording_sha256) {
      if (prior.dominant_recording_sha256.includes(recording)) conflicts.push({ recording_sha256: recording,
        current_work_id: current.work?.id ?? null, prior_work_id: prior.work.id,
        prior_source_sha256: prior.source.sha256, prior_delivery: prior.delivery ?? null,
        current_union_samples: current.recordings.find(row => row.recording_sha256 === recording).union_samples,
        prior_union_samples: prior.recordings.find(row => row.recording_sha256 === recording).union_samples });
    }
  }
  return { passed: !gaps.length && !conflicts.length,
    status: gaps.length ? 'cross_work_music_identity_gap' : conflicts.length ? 'cross_work_dominant_music_gap' : 'cross_work_music_passed',
    dominance_rule: 'largest_actual_recording_target_union_all_ties_included', conflicts, excluded, gaps: [...new Set(gaps)] };
}

async function boundJson(binding, context = null) {
  if (!path.isAbsolute(binding?.path ?? '') || !hash(binding?.sha256)) fail('cross_work_hash_bound_evidence_required');
  const key = `${normalized(binding.path)}:${binding.sha256}`;
  if (context?.bound.has(key)) {
    if (context.stats) context.stats.cache_hits = (context.stats.cache_hits ?? 0) + 1;
    return context.bound.get(key);
  }
  const reading = (async () => {
    if (context?.stats) {
      context.stats.filesystem_reads = (context.stats.filesystem_reads ?? 0) + 1;
      context.stats.reads_by_path ??= {};
      context.stats.reads_by_path[normalized(binding.path)] = (context.stats.reads_by_path[normalized(binding.path)] ?? 0) + 1;
    }
    const bytes = await readFile(binding.path);
    if (sha(bytes) !== binding.sha256) fail('cross_work_bound_evidence_changed');
    return parse(bytes.toString('utf8'));
  })();
  context?.bound.set(key, reading);
  return reading;
}

async function boundWork(source, binding, context = null) {
  const value = await boundJson(binding, context);
  if (value.kind !== 'host_validated_work_identity' || value.source?.sha256 !== source.sha256
    || !path.isAbsolute(value.source?.path ?? '')
    || typeof value.work_id !== 'string' || !value.work_id.trim()) fail('cross_work_validated_work_identity_required');
  return { id: value.work_id.trim(), title: value.work_title ?? null, basis: 'hash_bound_host_validated_work_identity',
    evidence: binding };
}

async function resolveWork(source, config, policy, context = readContext()) {
  if (!Array.isArray(policy?.work_identity_index)) fail('cross_work_work_identity_index_required');
  let index = context.identityIndexes.get(policy);
  if (!index) {
    index = new Map();
    for (const binding of policy.work_identity_index) {
      const value = await boundJson(binding, context);
      if (value.kind !== 'host_validated_work_identity' || !hash(value.source?.sha256)
        || !path.isAbsolute(value.source?.path ?? '') || typeof value.work_id !== 'string' || !value.work_id.trim())
        fail('cross_work_validated_work_identity_required');
      const rows = index.get(value.source.sha256) ?? [];
      rows.push({ id: value.work_id.trim(), title: value.work_title ?? null,
        basis: 'hash_bound_host_validated_work_identity', evidence: binding });
      index.set(value.source.sha256, rows);
    }
    context.identityIndexes.set(policy, index);
  }
  const matches = index.get(source.sha256) ?? [];
  if (!matches.length && isIndependentMusicPackTrial(config) && config.work_identity_evidence) {
    await validateIndependentMusicPackPolicy(config, { outputDirectory: config.output_dir
      ?? path.dirname(config.work_identity_evidence.path), operation: 'run_sound_job' });
    const registered = await boundJson(config.work_identity_evidence, context);
    if (!['caller_metadata_bound_by_host_to_actual_upload', 'first_title_in_verified_source_path',
      'unknown_family_grouped_by_upload_directory'].includes(registered.identity_basis))
      fail('cross_work_upload_host_registration_required');
    return boundWork(source, config.work_identity_evidence, context);
  }
  if (!matches.length) return null;
  if (new Set(matches.map(row => row.id)).size !== 1) fail('cross_work_conflicting_work_identity_bindings');
  // A caller's alternative title or unpinned evidence cannot override the project source-SHA identity.
  return matches[0];
}

function outputBinding(record, base, key) {
  const row = record.outputs?.[key], file = path.resolve(base, row?.path ?? '');
  if (!row?.path || !hash(row.sha256) || !inside(file, base)) fail('cross_work_completed_render_output_binding_required');
  return { path: file, sha256: row.sha256 };
}

// Cheap validation on subsequent jobs reads only the already verified small provenance files.
async function completedRenderFacts(runBinding, context = readContext()) {
  const record = await boundJson(runBinding, context), base = path.dirname(runBinding.path);
  if (record.schema_version !== 1 || ['failed', 'running', 'reference_music_budget_gap'].includes(record.status)
    || !['validate_inputs', 'prepare_original_audio', 'render', 'check_sound_coverage']
      .every(name => record.stages?.some(row => row.name === name && row.status === 'completed')))
    fail('cross_work_actual_complete_render_required');
  const planBinding = outputBinding(record, base, 'plan.json'), reportBinding = outputBinding(record, base, 'render/report.json');
  const manifestBinding = outputBinding(record, base, 'media/manifest.json');
  const [plan, report, manifest] = await Promise.all([boundJson(planBinding, context), boundJson(reportBinding, context), boundJson(manifestBinding, context)]);
  if (report.input_binding?.schema_version !== 1 || report.input_binding.plan_sha256 !== planBinding.sha256
    || report.input_binding.manifest_sha256 !== manifestBinding.sha256 || !samePath(plan.manifest, manifestBinding.path)
    || report.source_sha256 !== record.inputs?.source_video?.sha256 || manifest.source_sha256 !== report.source_sha256
    || report.duration_samples !== manifest.timeline?.duration_samples || report.sample_rate !== RATE
    || !samePath(manifest.source_video, record.inputs.source_video.path)) fail('cross_work_render_provenance_mismatch');
  for (const track of ['bgm', 'sfx', 'ambience', 'accompaniment']) {
    if (outputBinding(record, base, track).sha256 !== report.output_sha256?.[track]) fail('cross_work_render_provenance_mismatch');
  }
  for (const asset of plan.assets ?? []) {
    if (record.inputs.assets?.[asset.id]?.sha256 !== report.input_binding.asset_sha256?.[asset.id])
      fail('cross_work_render_provenance_mismatch');
  }
  const config = record.inputs.job ? await boundJson(record.inputs.job, context) : {};
  const workEvidence = record.cross_work_music?.current?.work?.evidence ?? config.work_identity_evidence;
  const work = workEvidence ? await boundWork(record.inputs.source_video, workEvidence, context)
    : workFromSourcePath(record.inputs.source_video.path);
  const recordingFamilies = record.cross_work_music?.current?.usage_contract_version === 2
    ? await independentRecordingFamilies(config, plan, record.inputs.assets, context) : null;
  const summary = summarizeActualMusic({ plan, assets: record.inputs.assets,
    durationSamples: manifest.timeline.duration_samples, source: record.inputs.source_video, work, recordingFamilies });
  return { record, plan, report, planBinding, reportBinding, manifestBinding, summary, config };
}

export async function registerCompletedMusicDelivery({ runRecordFile, historyRoot }) {
  if (!path.isAbsolute(runRecordFile ?? '') || !path.isAbsolute(historyRoot ?? '')) fail('cross_work_registry_absolute_paths_required');
  const runBinding = { path: path.resolve(runRecordFile), sha256: await hashFile(runRecordFile) };
  const facts = await completedRenderFacts(runBinding);
  if (!facts.summary.work?.id) fail('cross_work_validated_work_identity_required');
  const issues = await verifyRenderBinding(facts.planBinding.path, path.dirname(facts.reportBinding.path), facts.report);
  if (issues.length) fail('cross_work_actual_complete_render_binding_invalid');
  const receipt = { schema_version: 1, kind: 'actual_complete_render_music_delivery',
    run_record: runBinding, plan: facts.planBinding, manifest: facts.manifestBinding, render_report: facts.reportBinding,
    full_render_binding_verified_once: true, summary: facts.summary,
    production_approval: false, artistic_acceptance: 'not_assessed' };
  if (facts.record.completed_at) receipt.delivered_at = facts.record.completed_at;
  const bytes = JSON.stringify(receipt, null, 2) + '\n', digest = sha(bytes), file = path.join(historyRoot, `${digest}.json`);
  await mkdir(historyRoot, { recursive: true });
  try { await writeFile(file, bytes, { encoding: 'utf8', flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || await hashFile(file) !== digest) throw error; }
  const binding = { path: path.resolve(file), sha256: digest };
  // The index is opt-in and lazily bootstrapped; legacy receipt roots keep their layout.
  if (await stat(path.join(historyRoot, '.delivery-index', 'deliveries.sqlite')).catch(error => {
    if (error.code === 'ENOENT') return null; throw error;
  })) {
    const index = await openMusicDeliveryIndex(historyRoot);
    try { indexVerifiedMusicDelivery(index.db, binding, facts.summary, receipt.delivered_at ?? null); }
    finally { index.db.close(); }
  }
  return binding;
}

async function readVerifiedHistoryBinding(binding, policy, context) {
  const receipt = await boundJson(binding, context);
  if (receipt.schema_version !== 1 || receipt.kind !== 'actual_complete_render_music_delivery'
    || receipt.full_render_binding_verified_once !== true) fail('cross_work_actual_complete_render_receipt_required');
  const facts = await completedRenderFacts(receipt.run_record, context);
  if (JSON.stringify(facts.summary) !== JSON.stringify(receipt.summary)
    || JSON.stringify(facts.planBinding) !== JSON.stringify(receipt.plan)
    || JSON.stringify(facts.reportBinding) !== JSON.stringify(receipt.render_report)
    || JSON.stringify(facts.manifestBinding) !== JSON.stringify(receipt.manifest)) fail('cross_work_music_history_provenance_mismatch');
  const stableWork = policy.work_identity_index ? await resolveWork(facts.summary.source, facts.config, policy, context) : null;
  if (policy.status === 'active' && !stableWork) fail('cross_work_prior_work_identity_missing');
  return { ...facts.summary, ...(stableWork ? { work: stableWork } : {}), delivery: binding,
    ...(receipt.delivered_at ? { delivered_at: receipt.delivered_at } : {}) };
}

export async function loadCompletedMusicHistory(policy, { metadataReadStats = null, context = readContext(metadataReadStats), current = null,
  refreshIndex = false } = {}) {
  if (!path.isAbsolute(policy?.history_root ?? '') || !Array.isArray(policy.history_index ?? [])
    || policy.require_history !== undefined && typeof policy.require_history !== 'boolean') fail('cross_work_music_policy_invalid');
  if (policy.history_storage === 'sqlite_incremental' && current) {
    const index = await openMusicDeliveryIndex(policy.history_root);
    try {
      await syncMusicDeliveryIndex(policy.history_root, index.db, binding => readVerifiedHistoryBinding(binding, policy, context), { refresh: refreshIndex });
      const total = index.db.prepare('SELECT count(*) AS count FROM deliveries').get().count;
      if (policy.require_history !== false && !total) fail('cross_work_music_history_missing');
      for (const pinned of policy.history_index ?? []) if (!hash(pinned?.sha256) || !path.isAbsolute(pinned?.path ?? '')
        || !inside(pinned.path, policy.history_root) || path.basename(pinned.path) !== `${pinned.sha256}.json`)
        fail('cross_work_music_pinned_history_missing');
      const history = [];
      for (const binding of queryRelevantDeliveries(index.db, current, policy.history_index ?? []))
        history.push(await readVerifiedHistoryBinding(binding, policy, context));
      if (context.stats) { context.stats.index_total_deliveries = total; context.stats.index_selected_deliveries = history.length; }
      return history;
    } finally { index.db.close(); }
  }
  let names;
  try { names = await readdir(policy.history_root); }
  catch (error) { if (error.code !== 'ENOENT' || policy.require_history !== false) fail('cross_work_music_history_missing'); names = []; }
  const bindings = names.filter(name => name.endsWith('.json')).map(name => {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('cross_work_music_history_filename_invalid');
    return { path: path.resolve(policy.history_root, name), sha256: name.slice(0, -5) };
  });
  for (const pinned of policy.history_index ?? []) {
    if (!hash(pinned?.sha256) || !path.isAbsolute(pinned?.path ?? '') || !inside(pinned.path, policy.history_root)
      || path.basename(pinned.path) !== `${pinned.sha256}.json`
      || !bindings.some(row => samePath(row.path, pinned.path) && row.sha256 === pinned.sha256)) fail('cross_work_music_pinned_history_missing');
  }
  if (policy.require_history !== false && !bindings.length) fail('cross_work_music_history_missing');
  const history = [];
  for (const binding of bindings) {
    history.push(await readVerifiedHistoryBinding(binding, policy, context));
  }
  return history;
}

async function permittedRecordings(policy, current) {
  const permitted = new Set(), evidence = [];
  for (const entry of policy.exceptions ?? []) {
    const binding = entry.authorization_evidence, value = await boundJson(binding);
    if (value.kind !== 'direct_human_cross_work_dominant_music_exception' || value.status !== 'authorized'
      || value.authorization_type !== 'direct_human' || value.scope !== 'current_work_source_recording'
      || value.work_id !== current.work?.id || value.source_sha256 !== current.source.sha256
      || !hash(value.recording_sha256)) continue;
    permitted.add(value.recording_sha256); evidence.push(binding);
  }
  return { permitted, evidence };
}

// Selection needs concentration hints, not every old render plan decoded again.
export async function loadIncrementalMusicUsage(policy, { source_sha256, work_id, now = Date.now() }) {
  if (policy.history_storage !== 'sqlite_incremental') return null;
  const days = policy.independent_reuse_window_days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 365) fail('independent_music_history_window_invalid');
  const index = await openMusicDeliveryIndex(policy.history_root), context = readContext();
  try {
    await syncMusicDeliveryIndex(policy.history_root, index.db, binding => readVerifiedHistoryBinding(binding, policy, context));
    // Explicit pinned history is still verified even if it does not affect a candidate's ranking.
    for (const binding of policy.history_index ?? []) await readVerifiedHistoryBinding(binding, policy, context);
    if (policy.require_history !== false && !index.db.prepare('SELECT count(*) AS n FROM deliveries').get().n)
      fail('cross_work_music_history_missing');
    const rows = index.db.prepare(`WITH latest AS (
      SELECT receipt_sha,delivered_at,ROW_NUMBER() OVER(PARTITION BY source_sha
        ORDER BY COALESCE(julianday(delivered_at),0) DESC,receipt_sha) AS rank
      FROM deliveries WHERE source_sha<>? AND work_id<>?)
      SELECT r.recording_sha AS key,
        sum(CASE WHEN julianday(d.delivered_at) IS NULL THEN 1 ELSE 0 END) AS undated,
        sum(CASE WHEN julianday(d.delivered_at) BETWEEN julianday(?) AND julianday(?) THEN 1 ELSE 0 END) AS recent
      FROM latest d JOIN delivery_recordings r ON d.receipt_sha=r.receipt_sha WHERE d.rank=1 GROUP BY r.recording_sha`)
      .all(source_sha256, work_id, new Date(now-days*86400000).toISOString(), new Date(now).toISOString());
    return { recent_window_days: days, recent_usage_by_key: Object.fromEntries(rows.filter(row => row.recent).map(row => [row.key,row.recent])),
      undated_usage_by_key: Object.fromEntries(rows.filter(row => row.undated).map(row => [row.key,row.undated])),
      history_deliveries: policy.history_index ?? [], history_index_file: index.file,
      history_delivery_count: index.db.prepare('SELECT count(*) AS n FROM deliveries').get().n,
      status: 'independent_reuse_is_context_not_lifetime_song_ban', selection_approval: false };
  } finally { index.db.close(); }
}

export async function enforceCrossWorkDominantMusic({ config = {}, plan, assets, durationSamples, source,
  inputFiles = [], outputDirectory, cwd, policyPath }) {
  const loaded = await loadProjectTrialPolicy({ ...config, output_dir: outputDirectory }, { inputFiles, cwd, policyPath });
  if (loaded?.gap) return { ...loaded.gap, passed: false, project_policy: loaded.binding, gaps: [loaded.gap.code] };
  if (!loaded || loaded.policy.cross_work_music?.status !== 'active') return null;
  const policy = loaded.policy.cross_work_music;
  const base = { schema_version: 1, project_id: loaded.policy.project_id, project_policy: loaded.binding,
    history_root: policy.history_root, before_stage: 'prepare_original_audio_and_render',
    research_trial_does_not_waive: true, source_ratio_rule_changed: false, production_approval: false };
  try {
    const context = readContext();
    const independent = isIndependentMusicPackTrial(config);
    if (independent) await validateIndependentMusicPackPolicy(config, { outputDirectory, operation: 'run_sound_job' });
    const work = await resolveWork(source, config, policy, context);
    const recordingFamilies = independent ? await independentRecordingFamilies(config, plan, assets, context) : null;
    const current = summarizeActualMusic({ plan, assets, durationSamples, source, work, recordingFamilies });
    const history = await loadCompletedMusicHistory(policy, { context, current: independent ? current : null });
    if (independent) {
      const recentDays = policy.independent_reuse_window_days ?? 30;
      if (!Number.isSafeInteger(recentDays) || recentDays < 1 || recentDays > 365)
        fail('cross_work_independent_reuse_window_invalid');
      const comparison = compareIndependentMusicUsage(current, history, { recentDays });
      return { ...base, ...comparison, current, history_count: history.length,
        next_action: comparison.passed ? 'continue_current_plot_compatible_selection'
          : comparison.gaps.length ? 'bind_validated_work_identity_before_render' : 'revise_copied_ordered_arrangement',
        // Used by the reservation transaction; removed before persisting the run record.
        completed_history: history };
    }
    const comparison = compareDominantMusic(current, history);
    const { permitted, evidence } = await permittedRecordings(policy, current);
    const authorized = comparison.conflicts.filter(row => permitted.has(row.recording_sha256));
    comparison.conflicts = comparison.conflicts.filter(row => !permitted.has(row.recording_sha256));
    comparison.passed = !comparison.gaps.length && !comparison.conflicts.length;
    comparison.status = comparison.gaps.length ? 'cross_work_music_identity_gap'
      : comparison.conflicts.length ? 'cross_work_dominant_music_gap' : 'cross_work_music_passed';
    return { ...base, ...comparison, current, history_count: history.length,
      authorized_exceptions: authorized, authorization_evidence: evidence,
      next_action: comparison.passed ? 'continue_plot_and_sound_review'
        : comparison.gaps.length ? 'bind_validated_work_identity_before_render'
        : 'prepare_plot_compatible_material_or_obtain_specific_human_main_reuse_authorization' };
  } catch (error) {
    return { ...base, passed: false, status: /work_identity/.test(error.message) ? 'cross_work_music_identity_gap' : 'cross_work_music_history_gap', gaps: [error.message],
      conflicts: [], next_action: 'restore_hash_bound_actual_delivery_history_before_render' };
  }
}

// The legacy route retains its project-wide admission lock. The independently
// authorized route uses short reservation transactions and durable per-job
// ownership below; no timeout authorizes deleting another owner's lock.
export async function acquireProjectMusicRenderLock({ config = {}, inputFiles = [], outputDirectory, source, cwd, policyPath,
  plan, assets, durationSamples, jobBinding }) {
  const loaded = await loadProjectTrialPolicy({ ...config, output_dir: outputDirectory }, { inputFiles, cwd, policyPath });
  if (loaded?.gap) return { ...loaded.gap, passed: false, project_policy: loaded.binding };
  if (!loaded || loaded.policy.cross_work_music?.status !== 'active') return null;
  const historyRoot = loaded.policy.cross_work_music.history_root;
  if (!path.isAbsolute(historyRoot ?? '')) return { passed: false, status: 'cross_work_music_history_gap',
    next_action: 'restore_required_music_history_before_render' };
  if (isIndependentMusicPackTrial(config)) {
    try {
      // Keep old failed attempts and outputs. A dead process with a complete,
      // verifiable run is registered rather than blindly rendered a second time.
      const recovered = [];
      for (const previous of await listIndependentRenderReservations(historyRoot)) {
        if (!['reserved', 'recovery_required'].includes(previous.state) || !isDeadLocalRenderOwner(previous)) continue;
        const processes = await inspectDeadRenderProcessTree(previous);
        if (processes.status !== 'clear') {
          await holdIndependentRenderRecovery(historyRoot, previous, processes);
          recovered.push({ job_id: previous.job_id, status: 'recovery_required', processes });
          continue;
        }
        let receipt = null, failure = null;
        try {
          const runRecordFile = path.join(previous.output_directory, 'run-record.json');
          const record = parse(await readFile(runRecordFile, 'utf8'));
          if (record.music_render_reservation?.job_id !== previous.job_id
            || record.inputs?.job?.sha256 !== previous.identity.job_sha256
            || record.inputs?.source_video?.sha256 !== previous.identity.source_sha256)
            fail('cross_work_recovery_run_identity_mismatch');
          receipt = await registerCompletedMusicDelivery({ runRecordFile, historyRoot });
        } catch (error) { failure = error.code === 'ENOENT' ? 'dead_owner_without_complete_run_record' : error.message; }
        if (await recoverDeadIndependentRender(historyRoot, previous, { receipt, failure }))
          recovered.push({ job_id: previous.job_id, previous_output_directory: previous.output_directory, receipt, failure });
      }
      const checked = await enforceCrossWorkDominantMusic({ config, plan, assets, durationSamples, source,
        inputFiles, outputDirectory, cwd, policyPath });
      if (!checked?.passed) return checked;
      if (!hash(jobBinding?.sha256) || !path.isAbsolute(jobBinding?.path ?? '')) fail('cross_work_render_job_binding_required');
      const identity = { source_sha256: source.sha256, job_sha256: jobBinding.sha256,
        plan_sha256: sha(JSON.stringify(plan)) };
      const admission = await reserveIndependentRender({ historyRoot, jobId: sha(JSON.stringify(identity)), identity,
        summary: checked.current, outputDirectory: path.resolve(outputDirectory),
        completedHistory: checked.completed_history,
        compare: (current, history) => compareIndependentMusicUsage(current, history, { recentDays: checked.recent_days }) });
      if (admission.status === 'cross_work_music_already_completed') {
        const receipt = await boundJson(admission.existing_delivery);
        const verified = await registerCompletedMusicDelivery({ runRecordFile: receipt.run_record.path, historyRoot });
        if (verified.sha256 !== admission.existing_delivery.sha256) fail('cross_work_idempotent_delivery_changed');
      }
      const { completed_history, ...safeCheck } = checked;
      return { ...admission, recovered, cross_work_music: { ...safeCheck, ...(admission.comparison ?? {}) } };
    } catch (error) {
      return { passed: false, status: 'cross_work_music_history_gap', gaps: [error.message],
        next_action: 'restore_bound_history_or_recover_independent_reservation', render_calls: 0 };
    }
  }
  const lockPath = path.join(historyRoot, 'render-admission.lock'), owner = randomUUID();
  const value = { schema_version: 1, kind: 'project_music_render_admission_lock', owner_token: owner,
    project_id: loaded.policy.project_id, source_sha256: source?.sha256 ?? null,
    output_directory: path.resolve(outputDirectory), created_at: new Date().toISOString(), pid: process.pid };
  try {
    // The policy history must already exist; admission never creates or resets mandatory history.
    await writeFile(lockPath, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    return { passed: true, reservation: { path: lockPath, owner_token: owner }, history_root: historyRoot };
  } catch (error) {
    return { passed: false, status: error.code === 'EEXIST' ? 'cross_work_music_render_busy' : 'cross_work_music_history_gap',
      lock_path: lockPath, render_calls: 0, previews_created: 0,
      next_action: error.code === 'EEXIST' ? 'wait_for_current_render_or_resolve_owner_crash_hold'
        : 'restore_required_music_history_before_render' };
  }
}

export async function releaseProjectMusicRenderLock(reservation, { receipt = null, failure = null } = {}) {
  if (!reservation) return;
  if (reservation.kind === 'independent_render_reservation')
    return finishIndependentRender(reservation, { receipt, failure });
  const value = parse(await readFile(reservation.path, 'utf8'));
  if (value.owner_token !== reservation.owner_token) fail('cross_work_render_lock_owner_changed');
  await unlink(reservation.path);
}

export function startProjectMusicRenderHeartbeat(reservation) {
  if (reservation?.kind !== 'independent_render_reservation') return { stop: async () => {}, check: async () => {} };
  let failure = null, pending = Promise.resolve();
  const renew = () => { pending = pending.then(() => heartbeatIndependentRender(reservation)).catch(error => { failure = error; }); };
  const interval = setInterval(renew, Math.max(500, Math.floor(reservation.lease_ms / 3)));
  interval.unref();
  return { check: async () => { await pending; if (failure) throw failure; await heartbeatIndependentRender(reservation); },
    stop: async () => { clearInterval(interval); await pending; } };
}
