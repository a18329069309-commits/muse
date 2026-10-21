import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const validated = new WeakSet();
const hash = value => createHash('sha256').update(value).digest('hex');
const absolute = value => typeof value === 'string' && path.isAbsolute(value);
const normalize = value => path.resolve(value).replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
const inside = (file, root) => normalize(file) === normalize(root) || normalize(file).startsWith(`${normalize(root)}/`);

// This is a distinct, human-authorized diagnostic route; it never alters the default source quota.
export function isIndependentMusicPackTrial(config = {}) {
  return config.material_strategy === 'independent_music_packs'
    && config.source_policy?.kind === 'independent_pack_trial'
    && config.mode === 'research' && config.automatic_trial === true
    && config.trial_review_policy === 'diagnostic_candidates'
    && config.production_approval !== true && config.purpose !== 'production';
}

export function hasIndependentMusicPackFields(config = {}) {
  return config.material_strategy === 'independent_music_packs'
    || config.source_policy?.kind === 'independent_pack_trial'
    || config.trial_review_policy === 'diagnostic_candidates';
}

export async function validateIndependentMusicPackPolicy(config = {}, { outputDirectory, operation } = {}) {
  if (!hasIndependentMusicPackFields(config)) return null;
  if (!isIndependentMusicPackTrial(config)) throw Error('independent_music_pack_trial_scope_required');
  const binding = config.source_policy.authorization;
  if (!absolute(binding?.path) || !/^[a-f0-9]{64}$/.test(binding?.sha256 ?? ''))
    throw Error('independent_music_pack_authorization_binding_required');
  const bytes = await readFile(binding.path);
  if (hash(bytes) !== binding.sha256) throw Error('independent_music_pack_authorization_changed');
  const authorization = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const output = outputDirectory ?? config.output_dir ?? config.output_directory;
  if (authorization.schema_version !== 1
    || authorization.kind !== 'direct_human_independent_music_pack_trial_authorization'
    || authorization.status !== 'authorized' || authorization.scope !== 'independent_pack_trial'
    || authorization.production_approval !== false || authorization.material_or_listening_approval !== false
    || authorization.preserves_reference_source_policy !== true || !absolute(authorization.output_root)
    || !Array.isArray(authorization.operations) || !authorization.operations.length
    || !absolute(output) || !inside(output, authorization.output_root)
    || operation && !authorization.operations.includes(operation))
    throw Error('independent_music_pack_authorization_scope_mismatch');
  const result = Object.freeze({ kind: 'independent_pack_trial', authorization: Object.freeze({ ...binding }),
    output_root: authorization.output_root, preferred_hot_drama_percent: null,
    minimum_hot_drama_percent: null, maximum_auxiliary_percent: null, reference_ratio_required: false,
    review_policy: 'diagnostic_candidates', production_approval: false, qualification_granted: false });
  validated.add(result);
  return result;
}

export function isValidatedIndependentMusicPackPolicy(value) {
  return validated.has(value);
}
