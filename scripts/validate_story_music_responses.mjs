const RATE = 48000;
const text = value => typeof value === 'string' && value.trim().length > 0;
const requireFact = (condition, reason) => {
  if (!condition) throw new Error(`fine_handoff_story_music_${reason}`);
};
const range = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0] && Math.round(value[1] * RATE) > Math.round(value[0] * RATE);
const samples = value => value.map(seconds => Math.round(seconds * RATE));
const within = (inner, outer) => inner[0] >= outer[0] - 1 && inner[1] <= outer[1] + 1;
const ids = value => Array.isArray(value) && value.every(text) && new Set(value).size === value.length;

// This checks declared responses against already checked listening records. It never hears music.
export function validateStoryMusicResponses({ handoff, brief, tasks, plan, checkedMusic, durationSeconds }) {
  const states = { semantic_assessment: 'not_performed', artistic_acceptance: 'not_assessed', production_approval: false };
  if (handoff.schema_version === 1) return { status: 'not_checked_legacy', ...states };
  requireFact(handoff.schema_version === 2, 'version_invalid');
  const duration = Math.round(durationSeconds * RATE);
  requireFact(Number.isSafeInteger(duration) && duration > 0, 'duration_invalid');
  requireFact(Array.isArray(brief.music_actions) && brief.music_actions.length > 0, 'actions_required');
  requireFact(Array.isArray(handoff.action_responses), 'responses_required');
  requireFact(Array.isArray(brief.story_beats) && Array.isArray(tasks.cues)
    && Array.isArray(plan.cues) && Array.isArray(checkedMusic) && Array.isArray(handoff.selections), 'records_required');
  const actions = brief.music_actions, actionIds = new Set(), developmentReasons = new Set(), results = [];
  for (const action of actions) {
    requireFact(action && text(action.id) && text(action.story_beat_id) && text(action.intent)
      && range(action.target_range) && ['response', 'hold', 'silence'].includes(action.requirement), 'action_invalid');
    requireFact(!actionIds.has(action.id), 'action_id_duplicate');
    actionIds.add(action.id);
    const beats = brief.story_beats.filter(beat => beat.id === action.story_beat_id);
    requireFact(beats.length === 1 && range([beats[0].start_seconds, beats[0].end_seconds])
      && within(samples(action.target_range), samples([beats[0].start_seconds, beats[0].end_seconds]))
      && samples(action.target_range)[1] <= duration, 'action_beat_binding_invalid');
  }
  for (const task of tasks.cues) {
    requireFact(task && text(task.cue_id) && range(task.target_range) && ids(task.required_action_ids)
      && ids(task.story_beat_ids), 'task_action_binding_required');
    requireFact(task.required_action_ids.every(id => actionIds.has(id)), 'task_action_unknown');
    requireFact(task.story_beat_ids.every(id => brief.story_beats.some(beat => beat.id === id))
      && task.required_action_ids.every(id => task.story_beat_ids.includes(actions.find(action => action.id === id).story_beat_id)),
    'task_story_beat_binding_invalid');
  }
  for (const response of handoff.action_responses) {
    requireFact(response && actionIds.has(response.action_id), 'response_action_unknown');
  }
  for (const action of actions) {
    const matches = handoff.action_responses.filter(response => response.action_id === action.id);
    requireFact(matches.length === 1, 'action_response_missing_or_duplicate');
    const response = matches[0];
    requireFact(['replace', 'source_development', 'hold', 'words_overlay'].includes(response.response_kind), 'response_kind_unsupported');
    requireFact(action.requirement === (response.response_kind === 'hold' ? 'hold' : 'response'), 'requirement_mismatch');
    requireFact(text(response.plan_cue_id) && text(response.music_task_cue_id) && text(response.reason)
      && range(response.target_range) && range(response.source_range), 'response_invalid');
    const taskMatches = tasks.cues.filter(task => task.cue_id === response.music_task_cue_id);
    requireFact(taskMatches.length === 1 && taskMatches[0].required_action_ids.includes(action.id)
      && taskMatches[0].story_beat_ids.includes(action.story_beat_id), 'response_task_binding_invalid');
    const task = taskMatches[0], cueMatches = plan.cues.filter(cue => cue.id === response.plan_cue_id);
    if (response.response_kind === 'words_overlay') requireFact(task.music_role === 'words_candidate'
      && task.words_mode === 'vocal_overlay', 'words_overlay_task_required');
    requireFact(cueMatches.length === 1 && cueMatches[0].track === 'bgm', 'bgm_response_required');
    const cue = cueMatches[0];
    const selectionMatches = handoff.selections.filter(item => item.plan_cue_id === cue.id
      && item.music_task_cue_id === task.cue_id);
    const checked = checkedMusic.filter(item => item.plan_cue_id === cue.id && item.music_task_cue_id === task.cue_id);
    requireFact(selectionMatches.length === 1 && checked.length === 1
      && range(checked[0].reviewed_source_range) && range(checked[0].used_source_range)
      && text(checked[0].listening_input_sha256), 'checked_listening_binding_required');
    requireFact(range([cue.source_in_seconds, cue.source_out_seconds]), 'cue_source_range_invalid');
    const [sourceIn, sourceOut] = samples([cue.source_in_seconds, cue.source_out_seconds]);
    const hasStart = Object.hasOwn(cue, 'start_seconds'), hasSync = Object.hasOwn(cue, 'sync');
    requireFact(hasStart !== hasSync, 'cue_start_invalid');
    let start;
    if (hasStart) {
      requireFact(Number.isFinite(cue.start_seconds), 'cue_start_invalid');
      start = Math.round(cue.start_seconds * RATE);
    } else {
      requireFact(Number.isFinite(cue.sync?.target_seconds) && Number.isFinite(cue.sync?.source_anchor_seconds), 'cue_sync_invalid');
      const target = Math.round(cue.sync.target_seconds * RATE), anchor = Math.round(cue.sync.source_anchor_seconds * RATE);
      requireFact(cue.sync.target_seconds >= 0 && target < duration, 'cue_sync_target_invalid');
      requireFact(cue.sync.source_anchor_seconds >= cue.source_in_seconds
        && cue.sync.source_anchor_seconds < cue.source_out_seconds
        && anchor >= sourceIn && anchor < sourceOut, 'cue_sync_anchor_invalid');
      start = target - (anchor - sourceIn);
    }
    const end = start + sourceOut - sourceIn;
    requireFact(start < duration && end > 0 && end <= duration, 'cue_timeline_invalid');
    const effectiveTarget = [Math.max(0, start), end];
    const effectiveSource = effectiveTarget.map(sample => sourceIn + sample - start);
    const target = samples(response.target_range), source = samples(response.source_range);
    requireFact(effectiveTarget[1] > effectiveTarget[0] && within(target, effectiveTarget)
      && within(target, samples(action.target_range)) && within(target, samples(task.target_range)), 'target_response_window_invalid');
    const mappedSource = target.map(sample => sourceIn + sample - start);
    requireFact(source.every((sample, index) => Math.abs(sample - mappedSource[index]) <= 1), 'source_target_mapping_invalid');
    requireFact(within(source, effectiveSource) && within(source, samples(checked[0].used_source_range))
      && within(source, samples(checked[0].reviewed_source_range)), 'response_outside_listened_source');
    if (response.response_kind === 'source_development') {
      requireFact(!developmentReasons.has(response.reason.trim()), 'development_reason_not_distinct');
      developmentReasons.add(response.reason.trim());
    }
    results.push({ action_id: action.id, story_beat_id: action.story_beat_id, plan_cue_id: cue.id,
      music_task_cue_id: task.cue_id, response_kind: response.response_kind,
      target_range: response.target_range, source_range: response.source_range,
      mapped_source_samples: mappedSource, listening_input_sha256: checked[0].listening_input_sha256 });
  }
  return { status: 'verified_records_only', ...states, responses: results,
    limitations: ['Response reasons and development claims are supplied records, not independently heard or semantically validated.',
      'Gain changes do not establish orchestration changes; qualified input coverage does not establish artistic fit.',
      'BGM replace, source_development, hold and validated words_overlay are supported; accent and silence require a director revision.'] };
}
