// A versioned editing contract. It describes real renderer operands, never
// listening qualification, source instrumentation, or dramatic success.
const RATE = 48000, sample = value => Math.round(value * RATE);
const range = value => Array.isArray(value) && value.length === 2
  && value.every(Number.isFinite) && value[0] >= 0 && sample(value[1]) > sample(value[0]);
const intersection = (a, b) => [Math.max(a[0], b[0]), Math.min(a[1], b[1])];

export const actualEditOperationKinds = ['hold', 'source_switch', 'gain_change', 'gain_envelope',
  'accent', 'lyric_entry', 'source_development'];

export function musicEditSchema(base, version = 1) {
  if (version !== 2) return base;
  const schema = structuredClone(base);
  schema.properties.schema_version = { type: 'integer', enum: [2] };
  schema.required.push('schema_version');
  const music = schema.properties.music_edits.items;
  music.properties.gain_envelope = { type: ['array', 'null'], minItems: 2,
    description: 'Relative dB automation, with exact zero and task-duration endpoints. Null means no authored automation.',
    items: { type: 'object', additionalProperties: false, required: ['offset_seconds', 'gain_db'],
      properties: { offset_seconds: { type: 'number' }, gain_db: { type: 'number' } } } };
  music.required.push('gain_envelope');
  const response = schema.properties.action_responses.items;
  response.properties.response_kind.enum.push('edit_operation');
  response.properties.music_task_cue_ids = { type: 'array', minItems: 1, uniqueItems: true,
    items: { type: 'string' }, description: 'Actual tasks intersecting and jointly covering this complete action. Include the primary music_task_cue_id.' };
  response.properties.actual_edit_operation = { type: 'object', additionalProperties: false,
    required: ['kind', 'anchor_seconds'], properties: {
      kind: { type: 'string', enum: actualEditOperationKinds },
      anchor_seconds: { type: ['number', 'null'], description: 'Actual target entry/change/peak time; null only for hold, whole-range automation or unresolved source development.' } } };
  response.required.push('music_task_cue_ids', 'actual_edit_operation');
  return schema;
}

export function actionTaskIds(response, version = 1) {
  return version === 2 ? response.music_task_cue_ids : [response.music_task_cue_id];
}

export function rangesCover(windows, target) {
  if (!range(target) || !windows.length || windows.some(row => !range(row))) return false;
  const spans = windows.map(row => row.map(sample)).sort((a, b) => a[0] - b[0]);
  let end = sample(target[0]);
  for (const row of spans) {
    if (row[0] > end) return false;
    end = Math.max(end, row[1]);
  }
  return end >= sample(target[1]);
}

// Ownership is checked by the caller against the director's required_action_ids.
// Multiple tasks are permitted only when every claimed task actually intersects.
export function actionTasksCover(response, action, tasks, version = 1) {
  if (!range(action?.target_range) || !range(response?.target_range)
    || action.target_range.some((t, i) => sample(t) !== sample(response.target_range[i]))) return false;
  const ids = actionTaskIds(response, version);
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || !ids.includes(response.music_task_cue_id)) return false;
  const windows = [];
  for (const id of ids) {
    const rows = tasks.filter(row => row.cue_id === id && range(row.target_range));
    if (rows.length !== 1) return false;
    const clipped = intersection(rows[0].target_range, action.target_range);
    if (!range(clipped)) return false;
    windows.push(clipped);
  }
  const operation = response.actual_edit_operation;
  if (version === 2 && (!operation || !actualEditOperationKinds.includes(operation.kind)
    || operation.anchor_seconds !== null && (!Number.isFinite(operation.anchor_seconds)
      || sample(operation.anchor_seconds) < sample(action.target_range[0])
      || sample(operation.anchor_seconds) >= sample(action.target_range[1])))) return false;
  return rangesCover(windows, action.target_range);
}

export function validateGainEnvelope(points, duration, baseGain = 0) {
  if (!Array.isArray(points) || points.length < 2 || !Number.isFinite(duration) || sample(duration) <= 0
    || points.some((point, i) => !Number.isFinite(point.offset_seconds) || !Number.isFinite(point.gain_db)
      || sample(point.offset_seconds) < 0 || sample(point.offset_seconds) > sample(duration)
      || baseGain + point.gain_db < -40 || baseGain + point.gain_db > 12
      || i && sample(point.offset_seconds) <= sample(points[i - 1].offset_seconds))
    || sample(points[0].offset_seconds) !== 0 || sample(points.at(-1).offset_seconds) !== sample(duration))
    throw Error('music_edit_gain_envelope_must_cover_exact_task_with_sensible_gain');
  return points;
}
export function gainAt(points, offset) {
  if (offset <= points[0].offset_seconds) return points[0].gain_db;
  for (let i = 1; i < points.length; i++) if (offset <= points[i].offset_seconds) {
    const left = points[i - 1], right = points[i];
    return left.gain_db + (right.gain_db - left.gain_db)
      * (offset - left.offset_seconds) / (right.offset_seconds - left.offset_seconds);
  }
  return points.at(-1).gain_db;
}

// Words replacement may split a task. Preserve the authored curve's actual
// values on each retained part instead of restarting automation from zero.
export function sliceGainEnvelope(points, duration, retained, baseGain) {
  validateGainEnvelope(points, duration, baseGain);
  if (!range(retained) || retained[1] > duration + 1 / RATE) throw Error('music_edit_gain_envelope_slice_outside_task');
  const pointsInside = points.filter(point => sample(point.offset_seconds) > sample(retained[0])
    && sample(point.offset_seconds) < sample(retained[1]));
  return [{ offset_seconds: 0, gain_db: gainAt(points, retained[0]) },
    ...pointsInside.map(point => ({ offset_seconds: (sample(point.offset_seconds) - sample(retained[0])) / RATE, gain_db: point.gain_db })),
    { offset_seconds: (sample(retained[1]) - sample(retained[0])) / RATE, gain_db: gainAt(points, retained[1]) }];
}

// Explicit crossfade handles add real source before/after the core. Keep the
// authored core curve at its old source positions and hold only its end values.
export function extendGainEnvelope(points, duration, baseGain, lead = 0, tail = 0) {
  validateGainEnvelope(points, duration, baseGain);
  if (![lead, tail].every(value => Number.isFinite(value) && value >= 0))
    throw Error('music_edit_gain_envelope_handles_invalid');
  const shifted = points.map(point => ({ offset_seconds: (sample(point.offset_seconds) + sample(lead)) / RATE, gain_db: point.gain_db }));
  if (sample(lead) > 0) shifted.unshift({ offset_seconds: 0, gain_db: points[0].gain_db });
  if (sample(tail) > 0) shifted.push({ offset_seconds: (sample(duration) + sample(lead) + sample(tail)) / RATE, gain_db: points.at(-1).gain_db });
  return validateGainEnvelope(shifted, duration + lead + tail, baseGain);
}

export function compileActionPieceMappings(response, tasks, cues, selections) {
  const ids = actionTaskIds(response, 2), mappings = [];
  for (const id of ids) {
    const task = tasks.cues.find(row => row.cue_id === id);
    if (!task) throw Error('action_operation_task_missing');
    for (const cue of cues.filter(row => row.track === 'bgm'
      && selections.some(selected => selected.plan_cue_id === row.id && selected.music_task_cue_id === id))) {
      const actual = [cue.start_seconds, cue.start_seconds + cue.source_out_seconds - cue.source_in_seconds];
      const target = intersection(intersection(actual, task.target_range), response.target_range);
      if (!range(target)) continue;
      mappings.push({ music_task_cue_id: id, plan_cue_id: cue.id, target_range: target,
        source_range: target.map(t => (sample(cue.source_in_seconds) + sample(t) - sample(cue.start_seconds)) / RATE) });
    }
  }
  if (!rangesCover(mappings.map(row => row.target_range), response.target_range))
    throw Error('action_operation_actual_music_coverage_incomplete');
  return mappings;
}
