import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { filterOriginalReferenceRoutes } from './music_profile.mjs';
import { verifyReferenceCaseBindings } from './case_host_adapter.mjs';
import { isValidatedIndependentMusicPackPolicy } from './independent_music_policy.mjs';
import { verifyIndependentWindowRoute } from './independent_route_identity.mjs';
import { readActualPcmSourceClock } from './actual_pcm_source_clock.mjs';

const run = promisify(execFile), checked = new WeakMap(), RATE = 48000;
const here = path.dirname(fileURLToPath(import.meta.url));
export const musicSourceBudgetPolicy = Object.freeze({ sample_rate: RATE, preferred_hot_drama_percent: 100,
  minimum_hot_drama_percent: 70, maximum_auxiliary_percent: 30 });
const validSha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const requireBinding = value => {
  if (typeof value?.path !== 'string' || !path.isAbsolute(value.path) || !validSha(value.sha256))
    throw Error('music_budget_binding_required');
};
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const sample = value => {
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * RATE))) throw Error('music_budget_invalid_time');
  return Math.round(value * RATE);
};
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
};
function placements(plan, options) {
  const duration = options?.duration_samples;
  if (!Number.isSafeInteger(duration) || duration <= 0) throw Error('music_budget_duration_samples_required');
  if (options?.minimum_hot_drama_percent !== undefined && options.minimum_hot_drama_percent !== 70
    || options?.maximum_auxiliary_percent !== undefined && options.maximum_auxiliary_percent !== 30)
    throw Error('music_budget_policy_cannot_be_lowered');
  const ids = new Set(), assets = new Map((plan.assets ?? []).map(row => [row.id, row]));
  if (assets.size !== (plan.assets ?? []).length) throw Error('music_budget_duplicate_plan_asset');
  return (plan.cues ?? []).filter(row => row.track === 'bgm').flatMap(cue => {
    if (!cue.id || ids.has(cue.id) || !assets.has(cue.asset_id)) throw Error('music_budget_cue_or_asset_identity_required');
    ids.add(cue.id);
    if (!range([cue.source_in_seconds, cue.source_out_seconds])) throw Error('music_budget_source_window_required');
    const source = [sample(cue.source_in_seconds), sample(cue.source_out_seconds)], length = source[1] - source[0];
    const hasStart = Object.hasOwn(cue, 'start_seconds'), hasSync = Object.hasOwn(cue, 'sync');
    if (hasStart === hasSync || length <= 0) throw Error('music_budget_target_mapping_required');
    if (hasSync && (sample(cue.sync.target_seconds) < 0 || sample(cue.sync.target_seconds) >= duration
      || sample(cue.sync.source_anchor_seconds) < source[0] || sample(cue.sync.source_anchor_seconds) >= source[1]))
      throw Error('music_budget_sync_anchor_outside_window');
    const start = hasStart ? sample(cue.start_seconds) : sample(cue.sync.target_seconds)
      - (sample(cue.sync.source_anchor_seconds) - source[0]);
    if (start >= duration || start + length <= 0 || start + length > duration) throw Error('music_budget_target_outside_episode');
    const gain = cue.gain_db ?? 0;
    if (!Number.isFinite(gain) || gain < -40 || gain > 12 || cue.gain_envelope !== undefined
      && (!Array.isArray(cue.gain_envelope) || cue.gain_envelope.some(point =>
        !Number.isFinite(point.gain_db) || gain + point.gain_db < -40 || gain + point.gain_db > 12))) throw Error('music_budget_gain_invalid');
    return [{ cue, asset: assets.get(cue.asset_id), source_range: [cue.source_in_seconds, cue.source_out_seconds],
      rendered_source_range: [(source[0] + Math.max(0, -start)) / RATE, source[1] / RATE],
      target_range_samples: [Math.max(0, start), start + length] }];
  });
}
function sourceMap(provenance) {
  const rows = new Map();
  for (const row of provenance?.sources ?? []) {
    if (!row.asset_id || rows.has(row.asset_id)) throw Error('music_budget_duplicate_source_descriptor');
    rows.set(row.asset_id, row);
  } return rows;
}

// Pure sample geometry; unverified declarations can be inspected but can never pass a delivery gate.
export function evaluateMusicSourceBudget(plan, provenance, options) {
  const rows = placements(plan, options), sources = sourceMap(provenance), verified = checked.has(provenance);
  const independent = isValidatedIndependentMusicPackPolicy(options?.source_policy);
  if (options?.source_policy && !independent) throw Error('music_budget_validated_source_policy_required');
  if (verified && checked.get(provenance).source_policy !== (options?.source_policy ?? null))
    throw Error('music_budget_verified_policy_mismatch');
  const classified = rows.flatMap(row => {
    const source = sources.get(row.cue.asset_id), origin = verified ? source?.budget_origin : source?.origin;
    const activity = source?.window_activity?.find(window => window.source_range.every((value, i) => sample(value) === sample(row.rendered_source_range[i])));
    if (verified && (!source || !activity || path.resolve(options?.plan_directory ?? checked.get(provenance).plan_directory,
      row.asset.path) !== source.source.path || row.asset.sha256 && row.asset.sha256 !== source.source_sha256))
      throw Error('music_budget_verified_plan_mismatch');
    if (verified && activity.digital_silence) return [];
    const hot = origin === 'hot_drama' && validSha(source?.source_sha256)
      && (!row.asset.sha256 || row.asset.sha256 === source.source_sha256);
    return [{ ...row, origin: hot ? 'hot_drama' : 'auxiliary', declared_origin: source?.declared_origin ?? source?.origin ?? 'unknown' }];
  });
  const boundaries = [...new Set(classified.flatMap(row => row.target_range_samples))].sort((a, b) => a - b);
  const spans = []; let total = 0, hot = 0, auxiliary = 0;
  for (let i = 0; i + 1 < boundaries.length; i++) {
    const lo = boundaries[i], hi = boundaries[i + 1], active = classified.filter(row =>
      row.target_range_samples[0] < hi && row.target_range_samples[1] > lo);
    if (!active.length) continue;
    const origin = active.some(row => row.origin === 'auxiliary') ? 'auxiliary' : 'hot_drama';
    total += hi - lo; if (origin === 'hot_drama') hot += hi - lo; else auxiliary += hi - lo;
    spans.push({ target_range_samples: [lo, hi], origin, cue_ids: active.map(row => row.cue.id),
      ...(independent ? { source_origins: [...new Set(active.map(row => row.declared_origin))] } : {}) });
  }
  const ratioPassed = total > 0 && BigInt(hot) * 100n >= BigInt(total) * 70n
    && BigInt(auxiliary) * 100n <= BigInt(total) * 30n;
  const independentSourcesPassed = verified && !provenance.gaps?.length;
  return { schema_version: 1, policy: independent ? options.source_policy : musicSourceBudgetPolicy, fact_verification_performed: verified,
    passed: verified && total > 0 && (independent ? independentSourcesPassed : ratioPassed), ratio_passed: ratioPassed,
    reference_ratio_required: !independent,
    status: !total ? 'no_new_music' : !verified ? 'source_fact_verification_required'
      : independent ? independentSourcesPassed ? 'independent_pack_sources_verified_for_diagnostic' : 'independent_pack_source_gap'
        : ratioPassed ? 'music_source_budget_passed' : 'music_source_budget_failed',
    total_music_samples: total, hot_drama_samples: hot, auxiliary_samples: auxiliary,
    hot_drama_percent: total ? hot * 100 / total : 0, auxiliary_percent: total ? auxiliary * 100 / total : 0,
    spans, gaps: [...(provenance?.gaps ?? []), ...(!total ? ['actual_new_music_required'] : []),
      ...(!verified ? ['async_source_verification_required'] : []), ...(total && !ratioPassed && !independent ? ['hot_drama_minimum_70_percent_required'] : [])],
    qualification_granted: false, production_approval: false };
}

// Source identity is independent of phrase hearing/artistic approval. New phrases of the identical SHA remain researchable.
export async function verifyMusicSourceProvenance(plan, provenance, options = {}) {
  const independent = isValidatedIndependentMusicPackPolicy(options.source_policy);
  if (options.source_policy && !independent) throw Error('music_budget_validated_source_policy_required');
  const uses = placements(plan, options), supplied = sourceMap(provenance), verifiedSources = [], gaps = [];
  const base = options.plan_directory ?? process.cwd(), audio = new Map();
  let scope;
  const getScope = async () => {
    if (scope) return scope;
    let binding = options.scope?.binding ?? options.scope?.catalog;
    if (!binding) { const file = path.join(here, '../references/popular-drama-scope.json');
      binding = { path: file, sha256: await hashFile(file) }; }
    requireBinding(binding); await verifyEvidenceBindings(binding); const value = await readJson(binding.path);
    if (value.schema_version !== 1 || !Array.isArray(value.works)) throw Error('music_budget_reference_scope_required');
    if (!options.scope?.catalog || value.source_catalog_binding) requireBinding(value.source_catalog_binding);
    await verifyEvidenceBindings(value.source_catalog_binding);
    if (value.source_catalog_binding) {
      const catalog = await readJson(value.source_catalog_binding.path);
      const entries = new Set((catalog.works ?? []).map(row => JSON.stringify([row.work_id, row.title])));
      if (catalog.schema_version !== 1 || value.works.some(row => !entries.has(JSON.stringify([row.work_id, row.title]))))
        throw Error('music_budget_scope_catalog_entry_mismatch');
    }
    const works = new Set(value.works.map(row => JSON.stringify([row.work_id, row.title])));
    const aliases = value.verified_work_aliases ?? [];
    if (!Array.isArray(aliases) || aliases.some(row => !works.has(JSON.stringify([row.canonical_work_id, row.title]))))
      throw Error('music_budget_work_alias_canonical_identity_required');
    scope = { binding, catalog: value.source_catalog_binding, works, aliases }; return scope;
  };
  // Record the actual policy even for auxiliary-only plans; no popularity/collection threshold is inferred.
  if (!independent) try { await getScope(); } catch (error) { gaps.push({ gap: error.message }); }
  for (const [assetId, entries] of new Map(uses.map(row => [row.cue.asset_id, uses.filter(item => item.cue.asset_id === row.cue.asset_id)]))) {
    const asset = entries[0].asset, descriptor = supplied.get(assetId), file = path.resolve(base, asset.path);
    const sha = await hashFile(file);
    if (asset.sha256 && asset.sha256 !== sha || descriptor?.source_sha256 && descriptor.source_sha256 !== sha)
      throw Error('music_budget_actual_asset_hash_mismatch');
    if (!audio.has(sha)) {
      audio.set(sha, await readActualPcmSourceClock({path:file,sha256:sha}, {
        python:options.python, publication_binding:options.pcm_clock_publication,
        cache_directory:options.pcm_clock_cache_directory,
        output_directory:options.pcm_clock_output_directory}));
    }
    const sourceClock=audio.get(sha);
    if (entries.some(row => sample(row.source_range[1]) > sourceClock.decoded_samples)) throw Error('music_budget_actual_source_window_outside_audio');
    const verifiedSource = { asset_id: assetId, source_sha256: sha, source: { path: file, sha256: sha },
      actual_duration_samples: sourceClock.decoded_samples, actual_pcm_clock:sourceClock,
      budget_origin: 'auxiliary', declared_origin: descriptor?.origin ?? 'unknown' };
    verifiedSource.window_activity = [];
    for (const window of new Map(entries.map(row => [JSON.stringify(row.rendered_source_range.map(sample)), row.rendered_source_range])).values()) {
      const measured = await run('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(window[0]), '-i', file,
        '-t', String(window[1] - window[0]), '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-'],
      { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      const overall = measured.stderr.slice(measured.stderr.lastIndexOf('Overall'));
      const peak = overall.match(/Peak level dB:\s*(-inf|[-+\d.]+)/);
      if (!peak) throw Error('music_budget_window_signal_measurement_required');
      verifiedSource.window_activity.push({ source_range: window, digital_silence: peak[1] === '-inf',
        protocol: 'actual_ffmpeg_signal_measurement_not_listening', actual_model_calls: 0 });
    }
    if (descriptor?.origin === 'hot_drama') {
      try {
        const originScope = await getScope();
        requireBinding(descriptor.reference_case_binding?.database);
        const [actual] = await verifyReferenceCaseBindings([descriptor.reference_case_binding], options.python ?? 'python');
        if (JSON.stringify(actual.case).includes('current_unscored_target_not_reference_success_case'))
          throw Error('current_unscored_target_cannot_supply_reference_origin');
        const canonical = originScope.works.has(JSON.stringify([actual.work.work_id, actual.work.title]));
        let alias;
        if (!canonical) {
          alias = originScope.aliases.find(row => row.work_id === actual.work.work_id && row.title === actual.work.title
            && row.source_video_sha256 === actual.episode.source_video?.sha256);
          if (!alias) throw Error('actual_work_identity_not_in_bound_reference_scope');
          requireBinding(alias.evidence); await verifyEvidenceBindings(alias.evidence);
          const evidence = await readJson(alias.evidence.path);
          if (evidence.schema_version !== 1 || evidence.work_id !== actual.work.work_id
            || evidence.canonical_work_id !== alias.canonical_work_id || evidence.title !== actual.work.title
            || evidence.episode_id !== actual.episode.episode_id || evidence.source_video_sha256 !== actual.episode.source_video.sha256
            || evidence.actual_source_identity_checked !== true || evidence.qualification_granted !== false)
            throw Error('music_budget_work_alias_actual_media_mismatch');
          await verifyEvidenceBindings(alias.evidence);
        }
        if (!range(descriptor.identity?.support_range)) throw Error('recording_identity_support_range_required');
        const route = { route_id: 'source-budget:' + assetId, cue_id: assetId,
          case_ids: [actual.case.case_id], reference_source: actual.episode.source_video,
          reference_case_range: actual.case.source_range, source_candidates: [{ cue_id: assetId, asset_id: assetId,
            segment_id: 'identity-support', source_sha256: sha, source_range: descriptor.identity.support_range,
            source_relation: 'reviewed_reference_match', original_recording_evidence: descriptor.identity.original_recording_evidence }] };
        const result = await filterOriginalReferenceRoutes({ routes: [route] }, { cues: [{ cue_id: assetId }] });
        if (!result.caseRoutes.routes.length) throw Error(result.gaps[0]?.gap ?? 'recording_identity_not_verified');
        verifiedSource.budget_origin = 'hot_drama'; verifiedSource.identity = descriptor.identity;
        verifiedSource.scope_work_identity = { mode: canonical ? 'canonical_work_id_and_title' : 'verified_work_alias',
          canonical_work_id: canonical ? actual.work.work_id : alias.canonical_work_id, ...(alias ? { evidence: alias.evidence } : {}) };
        verifiedSource.reference_case_binding = descriptor.reference_case_binding;
        verifiedSource.reference = { work_id: actual.work.work_id, title: actual.work.title,
          episode_id: actual.episode.episode_id, episode_position: actual.episode.episode_id.match(/\/episode-(\d+)(?:\/|$)/)?.[1] ?? actual.episode.episode_id,
          source_video: actual.episode.source_video, source_range: actual.case.source_range };
      } catch (error) { gaps.push({ asset_id: assetId, gap: error.message }); }
    } else if (independent) {
      if (!['independent_library', 'user_provided', 'reviewed_equivalent'].includes(descriptor?.origin))
        throw Error('independent_pack_actual_origin_required');
      const declaredWindows = descriptor.windows ?? [descriptor], identities = new Set();
      if (!Array.isArray(declaredWindows) || !declaredWindows.length) throw Error('independent_pack_window_identity_required');
      verifiedSource.windows = [];
      for (const declared of declaredWindows) {
        const identity = JSON.stringify([declared.pack_id, declared.window_id, declared.route_kind ?? 'preset',
          declared.preset_id, declared.cue_id ?? null]);
        if (!declared.pack_id || !declared.window_id || identities.has(identity))
          throw Error('independent_pack_window_identity_required');
        identities.add(identity);
        requireBinding(declared.window_binding); await verifyEvidenceBindings(declared.window_binding);
        const document = await readJson(declared.window_binding.path);
        const windows = Array.isArray(document.windows) ? document.windows : [document.window ?? document];
        const matches = windows.filter(window => window.pack_id === declared.pack_id && window.window_id === declared.window_id);
        if (matches.length !== 1) throw Error('independent_pack_window_binding_mismatch');
        const window = matches[0], windowSha = window.source_sha256 ?? window.source?.sha256 ?? window.recording_sha256;
        if (windowSha !== sha || !range(window.source_range)
          || declared.source_range && (!range(declared.source_range)
            || declared.source_range[0] < window.source_range[0] - 1 / RATE || declared.source_range[1] > window.source_range[1] + 1 / RATE))
          throw Error('independent_pack_verified_window_mismatch');
        if (window.source?.path && path.resolve(window.source.path) !== file) throw Error('independent_pack_window_source_path_mismatch');
        const actualOrigin = window.origin ?? window.source_origin;
        if (actualOrigin && actualOrigin !== descriptor.origin) throw Error('independent_pack_window_origin_mismatch');
        let targetSha;
        if (declared.route_kind === 'sound_conditions') {
          const manifestFile = typeof plan.manifest === 'string' ? path.resolve(base, plan.manifest) : plan.manifest?.path;
          if (!manifestFile) throw Error('independent_pack_sound_conditions_target_manifest_required');
          if (typeof plan.manifest === 'object') await verifyEvidenceBindings(plan.manifest);
          targetSha = (await readJson(manifestFile)).source_sha256;
          if (!validSha(targetSha)) throw Error('independent_pack_sound_conditions_target_manifest_required');
        }
        const routeIdentity = await verifyIndependentWindowRoute(declared, window, { sourceSha: targetSha });
        if (window.cleanliness?.status === 'contaminated' || window.cleanliness === 'contaminated'
          || window.dialogue_contamination === true || window.delivery_admission === 'rejected')
          throw Error('independent_pack_contaminated_window_rejected');
        verifiedSource.windows.push({ pack_id: declared.pack_id, window_id: declared.window_id,
          ...routeIdentity, source_range: declared.source_range ?? window.source_range,
          window_binding: declared.window_binding, window_review_state: window.review_status ?? 'unreviewed_diagnostic_candidate' });
      }
      if (entries.some(row => !verifiedSource.windows.some(window => row.source_range[0] >= window.source_range[0] - 1 / RATE
        && row.source_range[1] <= window.source_range[1] + 1 / RATE))) throw Error('independent_pack_verified_window_mismatch');
      if (verifiedSource.windows.length === 1) Object.assign(verifiedSource, verifiedSource.windows[0]);
      verifiedSource.independent_window_verified = true;
      // Window binding and decode prove source identity, never lyrics, usage or listening approval.
      verifiedSource.material_approval_granted = false;
    }
    if (await hashFile(file) !== sha) throw Error('music_budget_asset_changed_during_verification');
    verifiedSources.push(verifiedSource);
  }
  if (scope) { await verifyEvidenceBindings(scope.binding); await verifyEvidenceBindings(scope.catalog); }
  const result = freeze({ schema_version: 1, sources: verifiedSources, scope: scope?.binding ?? null, gaps,
    source_verification: 'actual_file_and_reference_identity_checked', qualification_granted: false, production_approval: false });
  checked.set(result, { plan_directory: base, source_policy: options.source_policy ?? null }); return result;
}
