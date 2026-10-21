import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { saveJson, readJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import { workFromSourcePath } from './cross_work_music_gate.mjs';

// The host hashes the actual upload. Caller metadata is not a model's identity assertion.
export async function registerUploadedWork({ video, work_id, work_title, series_id, evidence, directory }) {
  if (!path.isAbsolute(video ?? '') || !path.isAbsolute(directory ?? '')) throw Error('upload_registration_absolute_paths_required');
  const source = { path: path.resolve(video), sha256: await hashFile(video) };
  if (evidence) {
    await verifyEvidenceBindings(evidence);
    const prior = await readJson(evidence.path);
    if (prior.kind !== 'host_validated_work_identity' || prior.source?.sha256 !== source.sha256
      || !prior.work_id?.trim() || work_id && prior.work_id !== work_id) throw Error('upload_registration_source_identity_mismatch');
    return { work_id: prior.work_id, work_identity_evidence: evidence };
  }
  const inferred = workFromSourcePath(video), id = series_id ?? work_id ?? inferred?.id
    ?? `unknown-upload:${source.sha256.slice(0, 24)}`;
  if (typeof id !== 'string' || !id.trim()) throw Error('upload_registration_work_metadata_invalid');
  const record = { schema_version: 1, kind: 'host_validated_work_identity', source,
    work_id: id.trim(), work_title: work_title ?? inferred?.title ?? null, series_id: series_id ?? null,
    identity_basis: series_id || work_id ? 'caller_metadata_bound_by_host_to_actual_upload'
      : inferred ? inferred.basis : 'unknown_family_scoped_to_actual_upload_sha',
    unknown_work_family: !series_id && !work_id && !inferred,
    production_approval: false, artistic_approval: false };
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${source.sha256}.json`);
  let binding;
  try { binding = await saveJson(file, record); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (JSON.stringify(await readJson(file)) !== JSON.stringify(record)) throw Error('upload_registered_work_identity_changed');
    binding = { path: file, sha256: await hashFile(file) };
  }
  return { work_id: record.work_id, work_identity_evidence: binding };
}
