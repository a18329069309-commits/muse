import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

// A publisher/editorial family label or title is a search hint, not proof that
// two files are variants of one work. Only an explicit, bound membership can
// consume a shared diversity slot. This grants no sound or usage approval.
export async function resolveVerifiedRecordingFamily(recording, publicationBinding) {
  const identity = recording?.family_identity;
  if (identity?.status !== 'verified') return null;
  const sha = recording.source_sha256 ?? recording.sha256;
  if (!/^[a-f0-9]{64}$/.test(sha ?? '') || typeof identity.family_id !== 'string'
    || !identity.family_id.trim() || !Array.isArray(identity.evidence) || !identity.evidence.length)
    throw Error('music_family_verified_membership_required');
  await verifyEvidenceBindings([publicationBinding, identity.evidence]);
  for (const binding of identity.evidence) {
    const proof = await readJson(binding.path);
    if (proof.kind !== 'verified_recording_family_membership' || proof.status !== 'verified'
      || proof.family_id !== identity.family_id || proof.recording_sha256 !== sha
      || typeof proof.basis !== 'string' || !proof.basis.trim())
      throw Error('music_family_membership_identity_mismatch');
  }
  return { family_id: identity.family_id, identity_basis: 'hash_bound_verified_recording_family_membership',
    evidence: identity.evidence };
}
