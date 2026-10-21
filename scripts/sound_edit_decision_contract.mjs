import { shaBytes } from './audio_api.mjs';

export const strictSoundEditDecisionRevision = 'strict-sound-decisions-v1';
const canonical = value => JSON.stringify(value, (_, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const same = (a, b) => canonical(a) === canonical(b);
const fail = reason => { throw Error('sound_edit_decision_' + reason); };

// A physical retain decision belongs to the original-track policy. The edit
// contract describes only additions, so its exact no-op spelling is "omit".
// This does not establish that the original sound exists or has been heard.
export function canonicalizeBoundPhysicalSoundRetains(input, original) {
  const data = input?.data, events = data?.analysis?.sound_events, guidance = data?.sound_event_guidance;
  const rows = original?.edits?.sounds;
  if (!Array.isArray(events) || !Array.isArray(guidance) || !Array.isArray(rows)
    || !Array.isArray(original.execution_gaps) || original.execution_gaps.length !== 0
    || new Set(events.map(row => row.id)).size !== events.length
    || new Set(guidance.map(row => row.event_id)).size !== guidance.length
    || new Set(rows.map(row => row.event_id)).size !== rows.length
    || rows.length !== events.length || rows.some(row => !events.some(event => event.id === row.event_id)))
    fail('unique_bound_events_required');
  const value = structuredClone(original), changes = [];
  for (const [index, edit] of rows.entries()) {
    if (edit.decision !== 'retain_original') continue;
    const event = events.find(row => row.id === edit.event_id), host = guidance.find(row => row.event_id === edit.event_id);
    if (!event || event.role !== 'physical' || event.decision !== 'retain_original'
      || !Number.isFinite(event.start_seconds) || !Number.isFinite(event.end_seconds)
      || event.start_seconds < 0 || event.end_seconds <= event.start_seconds
      || !host || host.role !== 'physical' || host.decision !== 'omit' || host.original_status !== 'unknown'
      || host.preserve_original_track !== true || host.selected_segment_id !== null || host.selected_source_range !== null
      || host.source_anchor_seconds !== null || edit.selected_segment_id !== null || edit.source_range !== null
      || ('asset_id' in edit && edit.asset_id !== null) || edit.original_status !== 'unknown'
      || !Number.isFinite(edit.target_seconds) || edit.target_seconds < event.start_seconds || edit.target_seconds > event.end_seconds
      || ![edit.gain_db, edit.fade_in_seconds, edit.fade_out_seconds, edit.source_anchor_seconds].every(n => n === 0)
      || typeof edit.reason !== 'string' || !edit.reason.trim() || typeof edit.anchor_evidence !== 'string' || !edit.anchor_evidence.trim())
      fail('only_bound_physical_original_track_noop');
    value.edits.sounds[index].decision = 'omit';
    changes.push({ event_id: edit.event_id, pointer: `/edits/sounds/${index}/decision`, from: 'retain_original', to: 'omit',
      event_sha256: shaBytes(canonical(event)), guidance_sha256: shaBytes(canonical(host)),
      original_edit_sha256: shaBytes(canonical(edit)), preserve_original_track: true });
  }
  if (!changes.length) fail('no_physical_alias_to_compile');
  const restored = structuredClone(value);
  for (const row of changes) restored.edits.sounds[Number(row.pointer.split('/')[3])].decision = row.from;
  if (!same(restored, original)) fail('other_field_changed');
  return { value, changes, original_model_value_sha256: shaBytes(canonical(original)), derived_value_sha256: shaBytes(canonical(value)) };
}

export function applyStrictSoundEditDecisionSchema(schema, revision) {
  if (revision === undefined) return schema;
  if (revision !== strictSoundEditDecisionRevision) fail('contract_revision_invalid');
  const next = structuredClone(schema);
  next.properties.edits.properties.sounds.items.properties.decision = { type: 'string', enum: ['new_asset', 'omit'],
    description: 'new_asset adds a supplied sound. omit adds nothing and preserves the original track, including unknown physical sounds. retain_original is an analysis policy, never an edit decision.' };
  return next;
}
