import path from 'node:path';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

const sameBinding = (a, b) => a?.sha256 === b?.sha256
  && path.resolve(a?.path ?? '') === path.resolve(b?.path ?? '');
const covers = (outer, inner) => Array.isArray(outer) && outer.length === 2 && outer.every(Number.isFinite)
  && outer[0] >= 0 && outer[1] > outer[0] && outer[0] <= inner[0] && outer[1] >= inner[1];

// This approves one fact about an existing source event, never a model, new
// recording, genre, or the final mixed scene. Predictions cannot use this path.
export async function loadOriginalSoundEventReview(binding, { source, original, manifest, event }) {
  await verifyEvidenceBindings(binding);
  const record = await readJson(binding.path);
  if (record.schema_version !== 1 || record.type !== 'offline_original_sound_event_review'
    || record.origin !== 'human' || record.status !== 'approved' || record.actual_audio_listened !== true
    || !record.reviewer?.trim() || !record.reason?.trim() || !Number.isFinite(Date.parse(record.reviewed_at))
    || record.event_id !== event.id || record.sound_role !== event.role
    || !['verified_missing', 'verified_insufficient'].includes(record.original_status)
    || !sameBinding(record.source_video, source) || !sameBinding(record.original_audio, original)
    || !sameBinding(record.manifest, manifest)
    || !covers(record.source_range, [event.start_seconds, event.end_seconds]))
    throw Error('original_sound_scoped_actual_human_event_review_required');
  await verifyEvidenceBindings([record.source_video, record.original_audio, record.manifest]);
  return { binding, record };
}

export async function findOriginalSoundEventReview(references, context) {
  if (references === undefined) return null;
  if (!Array.isArray(references)) throw Error('original_sound_review_bindings_array_required');
  const matches = [];
  for (const binding of references) {
    await verifyEvidenceBindings(binding);
    const record = await readJson(binding.path);
    if (record.event_id === context.event.id) matches.push(await loadOriginalSoundEventReview(binding, context));
  }
  if (matches.length > 1) throw Error('original_sound_event_review_ambiguous');
  return matches[0] ?? null;
}
