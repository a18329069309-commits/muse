import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hasIndependentMusicPackFields, validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';

// Local policy state is not bundled with public source. An explicit deployment
// may share its policy and protected roots; no authorization is generated here.
const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const projectTrialPolicyPath = process.env.SDR_PROJECT_TRIAL_POLICY
  ?? path.join(projectRoot, '.muse', 'project-trial-policy.json');
export const projectTrialFallbackRoots = process.env.SDR_PROJECT_TRIAL_ROOTS === undefined
  ? [path.join(projectRoot, '.muse', 'trials')]
  : JSON.parse(process.env.SDR_PROJECT_TRIAL_ROOTS);
if (!path.isAbsolute(projectTrialPolicyPath) || !Array.isArray(projectTrialFallbackRoots)
  || !projectTrialFallbackRoots.length
  || !projectTrialFallbackRoots.every(root => typeof root === 'string' && path.isAbsolute(root)))
  throw Error('project_trial_policy_location_invalid');
const referenceKinds = new Set(['source_preparation', 'recording_identity', 'asset_observation', 'reference_package_qa']);
const offlineOperations = new Set(['offline_corpus', 'source_identification', 'source_preparation', 'asset_observation', 'reference_package_qa',
  'target_analysis', 'target_material_preparation']);
const sha = value => createHash('sha256').update(value).digest('hex');
const normalize = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const inside = (file, root) => normalize(file) === normalize(root) || normalize(file).startsWith(`${normalize(root)}/`);
const parse = value => JSON.parse(value.replace(/^\uFEFF/, ''));
const absolute = value => typeof value === 'string' && path.isAbsolute(value);

function paths(value, result = [], depth = 0) {
  if (depth > 12 || !value) return result;
  if (typeof value === 'string' && absolute(value)) result.push(value);
  else if (Array.isArray(value)) for (const item of value) paths(item, result, depth + 1);
  else if (typeof value === 'object') for (const item of Object.values(value)) paths(item, result, depth + 1);
  return result;
}
function strings(value, result = [], depth = 0) {
  if (depth > 12 || !value) return result;
  if (typeof value === 'string') result.push(value);
  else if (Array.isArray(value)) for (const item of value) strings(item, result, depth + 1);
  else if (typeof value === 'object') for (const item of Object.values(value)) strings(item, result, depth + 1);
  return result;
}
async function boundJson(binding) {
  if (!absolute(binding?.path) || !/^[a-f0-9]{64}$/i.test(binding?.sha256 ?? '')) throw Error('bound_reference_evidence_required');
  const data = await readFile(binding.path);
  if (sha(data) !== binding.sha256) throw Error('bound_reference_evidence_changed');
  return parse(data.toString('utf8'));
}
async function contextDocuments(config, inputFiles) {
  const documents = [config ?? {}, ...(config?.independent_trial_context ? [config.independent_trial_context] : [])],
    queue = [...(inputFiles ?? [])].filter(absolute).map(file => ({ file }));
  for (const key of ['manifest', 'analysis', 'director', 'candidates', 'arc_plan', 'plan', 'job']) {
    const value = config?.[key];
    if (absolute(value)) queue.push({ file: value });
    else if (absolute(value?.path)) queue.push({ file: value.path, binding: value });
  }
  const seen = new Set();
  while (queue.length && seen.size < 18) {
    const { file, binding } = queue.shift();
    if (seen.has(normalize(file))) continue;
    seen.add(normalize(file));
    try {
      const data = await readFile(file);
      if (binding?.sha256 && sha(data) !== binding.sha256) continue;
      const doc = parse(data.toString('utf8')); documents.push(doc);
      if (doc.independent_trial_context) documents.push(doc.independent_trial_context);
      for (const key of ['manifest', 'plan']) {
        const value = doc[key];
        if (typeof value === 'string') queue.push({ file: path.resolve(path.dirname(file), value) });
        else if (absolute(value?.path)) queue.push({ file: value.path, binding: value });
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
  }
  return documents;
}

// A bare "technical_diagnostic" or caller-supplied research label never bypasses a user-film hold.
// Reference QA requires a real hash-bound public-acquisition receipt and cannot use the rejected target.
async function offlineReferenceAllowed(config, documents, policy) {
  const action = config?.offline_reference_action ?? documents.find(doc => doc?.offline_reference_action)?.offline_reference_action;
  if (!referenceKinds.has(action?.kind)) return false;
  const all = strings(documents);
  if ((policy.rejected_user_sources ?? []).some(hash => all.includes(hash))) return false;
  try {
    const source = action.source;
    if (!absolute(source?.path) || !/^[a-f0-9]{64}$/i.test(source?.sha256 ?? '')
      || sha(await readFile(source.path)) !== source.sha256) return false;
    // A public asset attached to a different user film cannot relabel that film as reference QA.
    if (documents.some(doc => doc.timeline && doc.source_video && doc.source_sha256 !== source.sha256
      || doc.source_video_sha256 && doc.source_video_sha256 !== source.sha256)) return false;
    for (const value of [config?.video, config?.source_video].filter(absolute)) {
      if (sha(await readFile(value)) !== source.sha256) return false;
    }
    const receipt = await boundJson(action.public_acquisition);
    const matches = candidate => candidate?.sha256 === source.sha256 && absolute(candidate.path)
      && normalize(candidate.path) === normalize(source.path);
    const https = value => { try { return new URL(value).protocol === 'https:'; } catch { return false; } };
    if (receipt.status === 'acquired_verified' && receipt.media?.full_decode_success === true
      && matches(receipt.media) && https(receipt.source_page)) return true;
    if (['acquisition_attempt_passed', 'complete_payload_finalized_and_fully_decoded'].includes(receipt.status)
      && matches(receipt.recording) && https(receipt.source_url)) return true;
    return receipt.status === 'official_preview_acquired_unverified'
      && (receipt.actual_recordings ?? []).some(row => matches(row.source) && https(row.official_entry?.trackViewUrl));
  } catch { return false; }
}

// A release is persisted by the host after target-specific preparation review.
// This changes project scheduling only; material identity and hearing checks still run downstream.
async function targetReleaseAllowed(config, documents, policy) {
  if (policy.new_trial_hold?.release_scope !== 'verified_target_material_preparation') return false;
  const targets = documents.filter(doc => doc?.source_video && doc?.source_sha256 && doc?.timeline);
  if (!targets.length || new Set(targets.map(doc => doc.source_sha256)).size !== 1) return false;
  const target = targets[0];
  const declared = documents.flatMap(doc => [doc?.source_sha256, doc?.source_video_sha256]).filter(Boolean);
  if (declared.some(value => value !== target.source_sha256)) return false;
  const actualVideos = new Set([config?.video, config?.source_video, config?.video?.path,
    config?.source_video?.path, ...targets.map(doc => doc.source_video)].filter(value => typeof value === 'string'));
  for (const release of policy.target_releases ?? []) {
    if (release.target_source_sha256 !== target.source_sha256) continue;
    try {
      const readiness = await boundJson(release.readiness_evidence);
      if (readiness.schema_version !== 1 || readiness.status !== 'target_material_preparation_verified'
        || readiness.target_source_sha256 !== target.source_sha256
        || readiness.required_tasks_unresolved?.length !== 0
        || readiness.actual_material_consumer_verified !== true
        || !readiness.verified_package_evidence?.length) continue;
      for (const binding of readiness.verified_package_evidence) await boundJson(binding);
      // Merely editing a manifest SHA cannot borrow a different target's release.
      if (!absolute(target.source_video)) continue;
      let sourcesMatch = true;
      for (const video of actualVideos) {
        if (!absolute(video) || sha(await readFile(video)) !== target.source_sha256) { sourcesMatch = false; break; }
      }
      if (!sourcesMatch) continue;
      return true;
    } catch { /* A missing/changed readiness artifact leaves this target pending. */ }
  }
  return false;
}

// A later human request may authorize one research test before corpus completion.
// This is scheduling authority, never a material-ready or hearing certificate.
async function explicitResearchTrialAllowed(config, documents, policy, operation) {
  if (documents.some(doc => doc?.mode === 'production' || doc?.production_approval === true)) return false;
  const output = config.output_dir ?? config.output_directory;
  if (!absolute(output)) return false;
  const targets = documents.filter(doc => doc?.source_video && doc?.source_sha256 && doc?.timeline);
  if (!targets.length || new Set(targets.map(doc => doc.source_sha256)).size !== 1) return false;
  const target = targets[0];
  if (documents.flatMap(doc => [doc?.source_sha256, doc?.source_video_sha256, doc?.target_source_sha256])
    .filter(Boolean).some(value => value !== target.source_sha256)) return false;
  const callerVideos = [config.video?.path ?? config.video, config.source_video?.path ?? config.source_video]
    .filter(Boolean);
  for (const video of callerVideos) if (!absolute(video) || sha(await readFile(video)) !== target.source_sha256) return false;
  for (const entry of policy.explicit_research_trials ?? []) {
    if (entry.production_approval !== false || entry.status !== 'authorized_single_research_trial'
      || entry.source?.sha256 !== target.source_sha256 || !absolute(entry.output_root)
      || !inside(output, entry.output_root) || !entry.operations?.includes(operation)) continue;
    try {
      const authorization = await boundJson(entry.authorization_evidence);
      if (authorization.kind !== 'direct_human_single_episode_trial_request'
        || authorization.source?.sha256 !== entry.source.sha256
        || normalize(authorization.output_root) !== normalize(entry.output_root)
        || authorization.material_or_listening_approval !== false) continue;
      if (!absolute(target.source_video) || sha(await readFile(target.source_video)) !== entry.source.sha256
        || sha(await readFile(entry.source.path)) !== entry.source.sha256) continue;
      return true;
    } catch { /* Changed evidence leaves the scheduling hold in place. */ }
  }
  return false;
}

// A scoped independent-pack authorization supersedes the earlier corpus scheduling hold only.
// Rejected material contexts and all source, window, rendering and listening checks stay active.
async function independentPackTrialAllowed(config, documents, operation) {
  if (documents.some(doc => doc?.mode === 'production' || doc?.production_approval === true
    || doc?.purpose === 'production')) return false;
  const output = config.output_dir ?? config.output_directory;
  for (const document of documents) {
    if (!hasIndependentMusicPackFields(document)) continue;
    await validateIndependentMusicPackPolicy({ ...document, output_dir: output },
      { outputDirectory: output, operation });
    return true;
  }
  return false;
}

export function rejectedUseContexts(documents, policy) {
  const values = strings(documents), text = values.join('\n');
  const finance = /financial-agency|wealth-independence|own-wealth|choose-and-revoke|财富|经济|撤资/i.test(text);
  const irony = /light-irony|playful-sarcasm|irony-and-freedom|反讽|轻爽|冷幽默/i.test(text);
  return (policy.negative_use_contexts ?? []).filter(row => values.includes(row.recording_sha256)
    && (values.includes(row.target_source_sha256) || finance && irony));
}

export async function loadProjectTrialPolicy(config = {}, { inputFiles = [], cwd = process.cwd(),
  policyPath = projectTrialPolicyPath } = {}) {
  const references = [cwd, ...inputFiles, ...paths(config)].filter(absolute);
  let policy, raw;
  try { raw = await readFile(policyPath); policy = parse(raw.toString('utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      if (!references.some(file => projectTrialFallbackRoots.some(root => inside(file, root)))) return null;
      return { policy: null, binding: { path: path.resolve(policyPath), sha256: null }, gap: {
        schema_version: 1, status: 'project_policy_gap', code: 'project_trial_policy_missing',
        before_stage: 'planning_model_render', render_calls: 0, previews_created: 0,
        no_output_directory_created: true, production_approval: false,
        next_action: 'restore_required_project_policy_before_new_trial' } };
    }
    throw Error('project_trial_policy_unreadable');
  }
  if (policy.schema_version !== 1 || !policy.project_scope || !policy.new_trial_hold)
    throw Error('project_trial_policy_invalid');
  const roots = [...(policy.project_scope.workspace_roots ?? []), ...(policy.project_scope.artifact_roots ?? [])];
  if (!references.some(file => roots.some(root => inside(file, root)))) return null;
  return { policy, binding: { path: path.resolve(policyPath), sha256: sha(raw) } };
}

export async function projectTrialPreflight(config = {}, { operation = 'user_film_trial', inputFiles = [],
  cwd = process.cwd(), policyPath = projectTrialPolicyPath } = {}) {
  // These are independent offline entry points, not names read from a user-film config.
  if (offlineOperations.has(operation)) return null;
  const loaded = await loadProjectTrialPolicy(config, { inputFiles, cwd, policyPath });
  if (!loaded) return null;
  if (loaded.gap) return { ...loaded.gap, project_policy: loaded.binding };
  const { policy, binding } = loaded;
  const documents = await contextDocuments(config, inputFiles);
  if (await offlineReferenceAllowed(config, documents, policy)) return null;
  const negative = rejectedUseContexts(documents, policy);
  if (!negative.length && await independentPackTrialAllowed(config, documents, operation)) return null;
  if (!negative.length && await explicitResearchTrialAllowed(config, documents, policy, operation)) return null;
  if (!negative.length && await targetReleaseAllowed(config, documents, policy)) return null;
  if (policy.new_trial_hold.status !== 'active' && !negative.length) return null;
  return {
    schema_version: 1, status: 'preproduction_pending', code: policy.new_trial_hold.status === 'active'
      ? 'project_no_new_user_trial' : 'rejected_music_use_context', project_id: policy.project_id,
    operation, hold_id: policy.new_trial_hold.hold_id, before_stage: 'planning_model_render',
    reason: policy.new_trial_hold.status === 'active' ? policy.new_trial_hold.reason
      : 'This recording was rejected for the proposed financial-agency/light-irony context; compatible material is still required.',
    required_preproduction: policy.new_trial_hold.required_preproduction,
    project_policy: binding,
    user_feedback: policy.new_trial_hold.authorization_evidence,
    rejected_use_contexts: negative.map(row => ({ id: row.id, recording_sha256: row.recording_sha256,
      scope: row.scope, feedback: row.feedback })),
    model_calls: 0, cloud_uploads: 0, generation_calls: 0, render_calls: 0, previews_created: 0,
    no_output_directory_created: true, new_user_trials_authorized: false, offline_research_allowed: true,
    offline_next_actions: ['continue_complete_reference_episode_research', 'identify_real_original_recordings',
      'prepare_clean_reference_windows_and_packages', 'close_plot_fit_material_gaps'],
    next_action: 'complete_user_required_preproduction_before_another_user_film_trial',
    source_ratio_rule_changed: false, global_recording_ban: false, qualification_granted: false, production_approval: false,
  };
}
