import path from 'node:path';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { validateAudioObservation } from './analysis_bridge.mjs';

// Shared by research assembly/rendering and the structural coverage checker.
// Audio observations retain their real kind and can never become verified transcripts or sync facts.
export async function verifyResearchAudioEvidence(row, { manifest, manifestBinding, research = true }) {
  const duration = manifest.timeline?.duration_samples / 48000;
  if (!research || row.kind !== 'audio_observation' || row.verified !== false || row.qualified !== false
    || row.sound_facts_qualified !== false || row.source_video_sha256 !== manifest.source_sha256
    || !path.isAbsolute(row.path ?? '') || !/^[a-f0-9]{64}$/.test(row.sha256 ?? '')
    || !Number.isFinite(row.start_seconds) || !Number.isFinite(row.end_seconds)
    || row.start_seconds < 0 || row.end_seconds <= row.start_seconds || row.end_seconds > duration)
    throw Error('research_audio_evidence_unqualified_binding_and_range_required');
  await verifyEvidenceBindings(row);
  const observation = await readJson(row.path);
  if (observation.source_video_sha256 !== manifest.source_sha256
    || observation.source_sha256 !== row.source_sha256
    || observation.source_range?.[0] !== row.start_seconds || observation.source_range?.[1] !== row.end_seconds
    || observation.sound_facts_qualified === true || observation.qualified === true)
    throw Error('research_audio_evidence_source_or_window_changed');
  const base = path.dirname(manifestBinding.path);
  const files = [manifest.original_audio, manifest.analysis_audio].filter(value => typeof value === 'string');
  if (!files.length) throw Error('research_audio_evidence_prepared_pcm_required');
  const hashes = await Promise.all(files.map(file => hashFile(path.resolve(base, file))));
  await validateAudioObservation(observation, manifest.source_sha256, hashes, duration,
    { allowUnqualifiedLocalResearch: observation.protocol === 'local_research_audio_prediction' });
  return { evidence_id: row.id, binding: { path: row.path, sha256: row.sha256 }, observation,
    verified: false, qualified: false, sound_facts_qualified: false, production_approval: false };
}
