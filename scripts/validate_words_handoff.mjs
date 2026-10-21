const rate = 48000;
const fact = (value, reason) => { if (!value) throw new Error(`fine_handoff_words_${reason}`); };
const span = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite)
  && value[0] >= 0 && value[1] > value[0];
const samples = value => value.map(v => Math.round(v * rate));
const within = (inner, outer) => inner[0] >= outer[0] - 1 && inner[1] <= outer[1] + 1;
const covered = (target, windows) => {
  let cursor = target[0];
  for (const [start, end] of windows.sort((a, b) => a[0] - b[0])) {
    if (start > cursor + 1) return false;
    cursor = Math.max(cursor, end);
  }
  return cursor >= target[1] - 1;
};
function placement(cue) {
  const source = samples([cue.source_in_seconds, cue.source_out_seconds]);
  const start = cue.start_seconds !== undefined ? Math.round(cue.start_seconds * rate)
    : Math.round(cue.sync.target_seconds * rate) - (Math.round(cue.sync.source_anchor_seconds * rate) - source[0]);
  return { target: [Math.max(0, start), start + source[1] - source[0]], offset: source[0] - start };
}

// Validate supplied words reviews and edit relationships; never listen or approve aesthetics.
export function validateWordsHandoff({ tasks, plan, handoff, reviews, checkedMusic }) {
  const childTasks = tasks.cues.filter(c => c.music_role === 'words_candidate'), results = [];
  for (const parent of tasks.cues.filter(c => c.music_role !== 'words_candidate')) {
    if (parent.words_candidate_request === 'require' && parent.words_target_range) {
      const children = childTasks.filter(c => c.parent_cue_id === parent.cue_id);
      fact(children.length === 1 && checkedMusic.some(c => c.music_task_cue_id === children[0].cue_id), 'required_child_missing');
    }
  }
  for (const child of childTasks) {
    const mappings = handoff.selections.filter(s => s.music_task_cue_id === child.cue_id);
    if (!mappings.length && child.words_candidate_request === 'explore') continue;
    fact(mappings.length === 1, 'child_selection_not_unique');
    const parents = tasks.cues.filter(c => c.cue_id === child.parent_cue_id && c.music_role !== 'words_candidate');
    fact(parents.length === 1 && span(child.parent_target_range) && span(child.target_range), 'parent_task_required');
    const parent = parents[0], target = samples(child.target_range), parentTarget = samples(parent.target_range);
    fact(JSON.stringify(child.parent_target_range) === JSON.stringify(parent.target_range)
      && child.parent_cue_sha256 === parent.director_cue_sha256 && child.parent_cue_sha256,
    'parent_context_mismatch');
    fact(within(target, parentTarget), 'target_outside_parent');
    const cue = plan.cues.find(c => c.id === mappings[0].plan_cue_id);
    fact(cue?.track === 'bgm' && cue.music_role === 'words_candidate'
      && cue.words_mode === child.words_mode, 'child_plan_role_or_mode_mismatch');
    const used = checkedMusic.filter(c => c.plan_cue_id === cue.id && c.music_task_cue_id === child.cue_id);
    fact(used.length === 1, 'child_listening_required');
    const review = reviews.reviews.find(r => r.cue_id === child.cue_id && r.segment_id === used[0].segment_id);
    const words = review?.words_evidence;
    fact(words?.content_status === 'verified' && words.vocal_presence === 'sung'
      && JSON.stringify(words) === JSON.stringify(used[0].words_evidence)
      && words.source_sha256 === used[0].source_sha256 && span(words.source_range)
      && within(samples(used[0].used_source_range), samples(words.source_range))
      && typeof words.actual_words === 'string' && words.actual_words.trim()
      && typeof words.vocal_language === 'string' && words.vocal_language.trim()
      && !['unknown', 'uncertain'].includes(words.vocal_language.toLowerCase())
      && ['unknown', words.vocal_language].includes(child.vocal_language ?? 'unknown'), 'verified_words_window_and_language_required');
    const parentMappings = handoff.selections.filter(s => s.music_task_cue_id === parent.cue_id);
    const parentCues = parentMappings.map(s => plan.cues.find(c => c.id === s.plan_cue_id));
    fact(parentCues.length && parentCues.every(c => c?.track === 'bgm' && c.music_role !== 'words_candidate')
      && parentCues.some(c => c.id === cue.parent_plan_cue_id), 'parent_music_mapping_required');
    const childPlacement = placement(cue), bases = parentCues.map(placement);
    fact(within(childPlacement.target, target) && covered(target, [childPlacement.target]), 'child_actual_target_coverage_required');
    if (child.words_mode === 'vocal_overlay') {
      fact(['isolated_vocal', 'verified_compatible_mix'].includes(words.mix_compatibility), 'overlay_clean_or_compatible_audio_required');
      fact(covered(parentTarget, bases.map(p => p.target)), 'overlay_cannot_replace_parent_coverage');
    } else {
      fact(['same_source_development', 'song_replace'].includes(child.words_mode), 'mode_invalid');
      fact(bases.every(p => Math.min(p.target[1], target[1]) - Math.max(p.target[0], target[0]) <= 1), 'replacement_must_not_stack_parent_accompaniment');
      fact(covered(parentTarget, [...bases.map(p => p.target), childPlacement.target]), 'parent_music_coverage_incomplete');
      if (child.words_mode === 'same_source_development') {
        fact(parentCues.every(c => checkedMusic.find(m => m.plan_cue_id === c.id)?.source_sha256 === used[0].source_sha256)
          && bases.every(p => Math.abs(p.offset - childPlacement.offset) <= 1), 'same_source_development_requires_continuous_source');
      }
    }
    results.push({ music_task_cue_id: child.cue_id, parent_cue_id: parent.cue_id,
      plan_cue_id: cue.id, words_mode: child.words_mode, target_range: child.target_range,
      source_sha256: used[0].source_sha256, listening_input_sha256: used[0].listening_input_sha256 });
  }
  return { status: 'verified_records_only', children: results, artistic_acceptance: 'not_assessed' };
}
