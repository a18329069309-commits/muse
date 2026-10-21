import { readJson } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

// Rendering a diagnostic is allowed to preserve an incomplete trial. Its
// bound coverage report must still reach the episode and batch gap queues.
export async function readPostRenderSoundGaps(rendered, resultBinding, source) {
  const coverage = rendered.render?.outputs?.['sound-coverage.json'];
  const declared = rendered.render?.coverage_status;
  if (!coverage) {
    if (declared === 'incomplete_sound_coverage')
      throw Error('post_render_sound_coverage_bound_report_required');
    return { status: 'sound_coverage_not_declared', gaps: [] };
  }
  if (!coverage.path || !/^[a-f0-9]{64}$/.test(coverage.sha256 ?? '') ||
      await hashFile(coverage.path) !== coverage.sha256)
    throw Error('post_render_sound_coverage_identity_changed');
  const report = await readJson(coverage.path);
  const rows = report.sound_task_gaps ?? [];
  if (!Array.isArray(rows)) throw Error('post_render_sound_task_gaps_array_required');
  const missing = rows.filter(row => row.required === true);
  if (missing.some(row => typeof row.event_id !== 'string' || !row.event_id ||
      typeof row.gap !== 'string' || !row.gap))
    throw Error('post_render_required_sound_gap_details_missing');
  const omittedIds = (report.issues ?? []).filter(row => row.problem === 'required_event_omitted').map(row => row.id);
  if (omittedIds.some(id => !missing.some(row => row.event_id === id &&
      row.gap === 'required_sound_event_has_no_actual_adoption')))
    throw Error('post_render_required_sound_gap_details_missing');
  const omittedCount = report.sound_treatment_counts?.required_events_omitted;
  if (omittedCount !== undefined && (!Number.isSafeInteger(omittedCount) || omittedCount < 0 ||
      omittedCount !== new Set(missing.filter(row =>
        row.gap === 'required_sound_event_has_no_actual_adoption').map(row => row.event_id)).size))
    throw Error('post_render_required_sound_gap_count_mismatch');
  return { status: missing.length ? 'required_sound_coverage_incomplete' : report.status,
    coverage, result: resultBinding, gaps: missing.map(row => ({
      event_id: row.event_id, reason: row.gap, required: true,
      adoption_decision: row.decision, editor_reason: row.reason,
      source_video_sha256: source.sha256, rendered_result: resultBinding,
      sound_coverage: coverage, blocks_render: false, blocks_completion: true,
      required_stage: 'sound_materials_and_edit', rendered_outputs_preserved: true,
      qualification_granted: false, production_approval: false,
    })) };
}
