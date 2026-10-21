// Contextual audio facts supplement an unchanged adoption pointer; never Ready.
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

export function contextRanges(candidate) {
  const contexts = candidate.observation_contexts ?? [];
  const pointer = candidate.candidate;
  if (!Array.isArray(contexts) || contexts.length > 2) throw new Error('bounded_observation_contexts_required');
  const seen = new Set();
  for (const context of contexts) {
    const range = context.source_range, anchor = pointer.source_range;
    if (context.context_only !== true || context.source_sha256 !== pointer.source_sha256
      || !context.purpose?.trim() || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
      || !(0 <= range[0] && range[0] < range[1] && range[1] - range[0] <= 25
        && range[0] <= anchor[0] && anchor[1] <= range[1])
      || JSON.stringify(range) === JSON.stringify(anchor) || seen.has(JSON.stringify(range)))
      throw new Error('observation_context_cannot_change_anchor_or_adoption');
    seen.add(JSON.stringify(range));
  }
  return contexts;
}

export async function verifyObservationContexts(candidate) {
  const contexts = contextRanges(candidate), pointer = candidate.candidate;
  if (!contexts.length) return contexts;
  const decode = candidate.bridge_recording_role?.decode_receipt;
  if (!decode) throw new Error('context_actual_decoded_source_bounds_required');
  await verifyEvidenceBindings(decode);
  const receipt = await readJson(decode.path);
  if (receipt.actual_audio_processed !== true || receipt.source?.sha256 !== pointer.source_sha256
    || !Number.isFinite(receipt.decoded_duration_seconds) || receipt.decoded_duration_seconds <= 0)
    throw new Error('context_actual_decoded_source_bounds_required');
  for (const context of contexts) {
    if (context.source_range[1] > receipt.decoded_duration_seconds)
      throw new Error('observation_context_outside_actual_recording');
  }
  return contexts;
}

export async function scopedHumanContextFacts(reference, sourceSha, ranges) {
  if (!reference) return null;
  await verifyEvidenceBindings(reference);
  const review = await readJson(reference.path), range = review.source_range;
  if (review.type !== 'offline_human_window_review' || review.origin !== 'human' || review.status !== 'approved'
    || review.actual_audio_listened !== true || review.source_audio?.sha256 !== sourceSha
    || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite) || !(0 <= range[0] && range[0] < range[1])
    || ranges.some(window => !(range[0] <= window[0] && window[0] < window[1] && window[1] <= range[1])))
    throw new Error('human_context_fact_source_range_scope_mismatch');
  await verifyEvidenceBindings([review.source_audio, review.audition_media].filter(Boolean));
  return { review: reference, source_sha256: sourceSha, reviewed_source_range: range,
    used_observation_ranges: ranges, music_form: review.music_form ?? 'unknown',
    actual_lyrics_present: review.observations?.actual_lyrics_present ?? 'unknown',
    cleanliness: review.cleanliness ?? {}, approved_function: review.observations?.approved_function ?? null,
    approved_sound_functions: review.approved_sound_functions ?? [], conditions: review.conditions ?? {},
    exclude_conditions: review.exclude_conditions ?? [], case_ids: review.case_ids ?? [],
    current_use_context_automatically_approved: false, new_human_review_performed: false,
    complete_lyric_phrase_approved: false, production_approval: false, Ready: false,
    scope: 'Existing reviewed source facts and original conditions only; no current-scene adoption or complete phrase approval' };
}
