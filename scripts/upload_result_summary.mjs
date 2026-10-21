// A failed completion check can still leave a useful diagnostic render.
// Report its real per-episode paths without changing its status or eligibility.
const gapSummary = gap => Object.fromEntries([
  'gap_id', 'event_id', 'object_id', 'reason', 'stage', 'required_stage',
  'target_range', 'blocks_render', 'blocks_completion', 'required',
].filter(key => gap?.[key] !== undefined).map(key => [key, gap[key]]));

export function summarizeUploadedEpisodeResult(result) {
  const episodes = result.episodes && !Array.isArray(result.episodes)
    ? Object.entries(result.episodes).map(([episode_id, row]) => ({
      episode_id, status: row.status, record: row.automatic_record ?? row.checkpoint ?? null,
      audio_dir: row.audio_dir ?? null, preview: row.preview ?? null,
      gaps: (row.gaps ?? []).map(gapSummary),
      error: row.error ?? null, failure_evidence: row.failure_evidence ?? null,
      next_action: row.next_action ?? null,
      actual_audio_listened: row.actual_audio_listened === true,
      production_approval: false,
    })) : undefined;
  return {
    status: result.status,
    record: result.automatic_record ?? result.checkpoint ?? result.codex_entry_record,
    audio_dir: result.audio_dir ?? null, preview: result.preview ?? null,
    gaps: Array.isArray(result.gaps) ? result.gaps.map(gapSummary) : null,
    error: result.error ?? null, failure_evidence: result.failure_evidence ?? null,
    next_action: result.next_action ?? null,
    ...(episodes ? {episodes, material_gap_queue: result.material_gap_queue ?? null} : {}),
    production_approval: false,
  };
}
