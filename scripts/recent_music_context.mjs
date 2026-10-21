import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

// This loads actual delivered identity records for comparison, not an aesthetic reuse prohibition.
export async function recentMusicContext(bindings = [], { sourceSha, workId } = {}) {
  if (!Array.isArray(bindings)) throw new Error('recent_delivered_music_bindings_required');
  const deliveries = [], excluded = [];
  for (const binding of bindings) {
    if (!binding?.path || !/^[a-f0-9]{64}$/.test(binding.sha256 ?? ''))
      throw new Error('recent_actual_delivery_binding_required');
    await verifyEvidenceBindings(binding);
    const value = await readJson(binding.path), priorSha = value.source_video_sha256 ?? value.input?.sha256;
    if (!/^[a-f0-9]{64}$/.test(priorSha ?? '') || !value.preview?.path
      || !/^[a-f0-9]{64}$/.test(value.preview.sha256 ?? '') || !Array.isArray(value.selected_music))
      throw new Error('recent_actual_delivery_record_required');
    await verifyEvidenceBindings(value.preview);
    if (value.selected_music.some(row => !/^[a-f0-9]{64}$/.test(row.source_sha256 ?? '')
      || !Array.isArray(row.source_range) || row.source_range.length !== 2 || !row.source_range.every(Number.isFinite)
      || row.source_range[0] < 0 || row.source_range[1] <= row.source_range[0]))
      throw new Error('recent_delivered_recording_windows_required');
    const priorWork = value.work_id ?? binding.work_id;
    if (priorSha === sourceSha || workId && priorWork === workId) {
      excluded.push({ delivery: binding, reason: priorSha === sourceSha ? 'same_source' : 'same_work_theme_allowed' });
      continue;
    }
    deliveries.push({ delivery: binding, delivered_preview: value.preview, source_video_sha256: priorSha,
      work_id: priorWork ?? null, relationship: workId && priorWork ? 'different_work' : 'work_identity_unknown_no_automatic_ban',
      selected_music: value.selected_music.map(row => ({ cue_id: row.cue_id, source_sha256: row.source_sha256,
        source_range: row.source_range, segment_id: row.segment_id })) });
  }
  return { status: deliveries.length ? 'actual_delivery_context_for_comparison'
    : bindings.length ? 'no_other_work_deliveries_after_identity_filter' : 'not_performed_no_recent_delivery_evidence',
  deliveries, excluded, scope: 'Recording identity context only; same-work theme reuse is allowed and artistic reuse review is not granted.',
  artistic_reuse_approval: false };
}
