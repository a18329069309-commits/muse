import path from 'node:path';
import { readFile, writeFile, rename, open, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { projectTrialPolicyPath, rejectedUseContexts } from './project_trial_gate.mjs';
import { prepareResearchTrial } from './render_research_trial.mjs';

// Publishes scheduling evidence only, after the existing material/render compiler has validated it.
export async function publishTargetReadiness(preparationBinding, { policyPath = projectTrialPolicyPath,
  outputDirectory, renderConfigBinding } = {}) {
  await verifyEvidenceBindings([preparationBinding, renderConfigBinding]);
  let prepared = await readJson(preparationBinding.path);
  const config = await readJson(renderConfigBinding.path);
  if (prepared.kind !== 'host_render_preparation_preflight' || prepared.status !== 'target_material_preparation_verified'
    || prepared.actual_material_consumer_verified !== true || prepared.required_tasks_unresolved?.length !== 0
    || prepared.render_calls !== 0 || prepared.previews_created !== 0
    || prepared.music_source_budget?.passed !== true || config.mode !== 'assisted_trial'
    || !prepared.verified_package_evidence?.length || !prepared.prepared_job || !prepared.inputs?.manifest)
    throw new Error('actual_reviewed_material_preflight_required_for_target_release');
  if (!path.isAbsolute(outputDirectory ?? '')) throw new Error('target_release_absolute_output_required');
  const out = path.resolve(outputDirectory); await mkdir(out, { recursive: false });
  // A JSON receipt supplied by a caller is not authority: rerun the real compiler
  // and all material/source checks before writing shared scheduling state.
  const verified = await prepareResearchTrial({ ...config, preview: false,
    output_dir: path.join(out, 'compiler-verification') });
  if (verified.status !== 'target_material_preparation_verified' || !verified.preparation_receipt)
    throw new Error('target_release_real_compiler_verification_required');
  const verifiedBinding = verified.preparation_receipt;
  await verifyEvidenceBindings(verifiedBinding);
  prepared = await readJson(verifiedBinding.path);
  await verifyEvidenceBindings([prepared.prepared_job, prepared.prepared_plan, prepared.prepared_design,
    ...Object.values(prepared.inputs), ...prepared.verified_package_evidence]);
  const manifest = await readJson(prepared.inputs.manifest.path);
  const source = path.resolve(path.dirname(prepared.inputs.manifest.path), manifest.source_video);
  if (manifest.source_sha256 !== prepared.source_video_sha256 || await hashFile(source) !== manifest.source_sha256
    || manifest.timeline?.duration_samples !== prepared.duration_samples)
    throw new Error('target_release_actual_source_clock_required');
  const candidates = await readJson(config.candidates.path), director = await readJson(config.director.path);
  const receipt = await saveJson(path.join(out, 'target-readiness.json'), {
    schema_version: 1, status: 'target_material_preparation_verified', target_source_sha256: manifest.source_sha256,
    source: { path: source, sha256: manifest.source_sha256 }, duration_samples: prepared.duration_samples,
    required_tasks_unresolved: [], actual_material_consumer_verified: true,
    verified_package_evidence: prepared.verified_package_evidence, material_preflight: verifiedBinding,
    original_preflight: preparationBinding, host_recompiled_before_release: true,
    render_config: renderConfigBinding, music_source_budget: prepared.music_source_budget.receipt,
    source_budget_evaluated_after_selection: true, scope: 'target_scheduling_only_not_artistic_or_model_approval',
    artistic_acceptance: 'not_assessed', production_approval: false });
  const policyFile = path.resolve(policyPath), lockFile = policyFile + '.release.lock';
  const lock = await open(lockFile, 'wx');
  try {
    const before = await readFile(policyFile), policy = JSON.parse(before.toString('utf8').replace(/^\uFEFF/, ''));
    if (policy.schema_version !== 1 || policy.new_trial_hold?.release_scope !== 'verified_target_material_preparation')
      throw new Error('target_release_policy_scope_mismatch');
    if (rejectedUseContexts([config, manifest, candidates, director], policy).length)
      throw new Error('target_release_rejected_music_use_context');
    const snapshot = path.join(out, 'project-policy-before.json'); await writeFile(snapshot, before, { flag: 'wx' });
    policy.target_releases ??= [];
    const prior = policy.target_releases.find(row => row.target_source_sha256 === manifest.source_sha256
      && row.readiness_evidence?.sha256 === receipt.sha256);
    if (!prior) policy.target_releases.push({ target_source_sha256: manifest.source_sha256,
      readiness_evidence: receipt, published_at: new Date().toISOString(), issuer: 'host_reviewed_material_preflight' });
    policy.updated_at = new Date().toISOString();
    if (!(await readFile(policyFile)).equals(before)) throw new Error('target_release_policy_changed_during_publish');
    const temporary = policyFile + '.release-' + randomUUID();
    await writeFile(temporary, JSON.stringify(policy, null, 2) + '\n', { flag: 'wx' });
    await rename(temporary, policyFile);
    return { status: 'target_release_published', readiness: receipt, policy: { path: policyFile, sha256: await hashFile(policyFile) },
      scope: 'specific_reviewed_target_only', render_calls: 0, production_approval: false };
  } finally {
    await lock.close();
    const { unlink } = await import('node:fs/promises'); await unlink(lockFile);
  }
}
