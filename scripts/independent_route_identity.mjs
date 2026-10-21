import path from 'node:path';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

const text = value => typeof value === 'string' && Boolean(value.trim());

// Recipe identity and current story identity are distinct. A direct route never
// invents a successful reference or promotes labels to verified audio facts.
export async function verifyIndependentWindowRoute(declared, window, { sourceSha } = {}) {
  const kind = declared.route_kind ?? 'preset';
  if (kind === 'preset') {
    if (!text(declared.preset_id) || !(window.preset_ids ?? [window.preset_id]).includes(declared.preset_id))
      throw Error('independent_pack_preset_binding_mismatch');
    return { route_kind: 'preset', preset_id: declared.preset_id };
  }
  const binding = declared.condition_binding;
  if (kind !== 'sound_conditions' || declared.preset_id !== null || !text(declared.cue_id)
    || !path.isAbsolute(binding?.path ?? '') || !/^[a-f0-9]{64}$/.test(binding?.sha256 ?? ''))
    throw Error('independent_pack_sound_conditions_binding_required');
  await verifyEvidenceBindings(binding);
  const context = await readJson(binding.path);
  if (context.kind !== 'independent_pack_target_context' || context.successful_reference_case !== false
    || !/^[a-f0-9]{64}$/.test(context.source_video_sha256 ?? '')
    || sourceSha && context.source_video_sha256 !== sourceSha)
    throw Error('independent_pack_sound_conditions_current_target_mismatch');
  await verifyEvidenceBindings([context.source, context.analysis, context.director, context.manifest, context.publication]);
  const [analysis, director, manifest] = await Promise.all([context.analysis, context.director, context.manifest]
    .map(reference => readJson(reference.path)));
  const cueId = declared.cue_id.endsWith('/words') ? declared.cue_id.slice(0, -6) : declared.cue_id;
  const cue = context.cues?.find(row => row.cue_id === cueId);
  if (!context.source || context.source.sha256 !== context.source_video_sha256
    || analysis.source_video_sha256 !== context.source_video_sha256
    || director.source_video_sha256 !== context.source_video_sha256 || manifest.source_sha256 !== context.source_video_sha256
    || !cue || !text(cue.function) || !text(cue.sound_goal) || !cue.story_beat_ids?.length
    || !director.cues?.some(row => JSON.stringify(row) === JSON.stringify(cue))
    || cue.story_beat_ids.some(id => !analysis.story_beats?.some(row => row.id === id)))
    throw Error('independent_pack_sound_conditions_current_target_mismatch');
  return { route_kind: kind, preset_id: null, cue_id: declared.cue_id, condition_binding: binding };
}
