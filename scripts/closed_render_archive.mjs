// An independent append-only delivery stage. It never changes creative evidence.
import path from 'node:path';
import { readFile, stat, mkdir, writeFile, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const archiveRevision = 'append-only-render-delivery-v1';
const run = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const normal = file => path.resolve(file).toLowerCase();
const validSha = value => /^[a-f0-9]{64}$/.test(value ?? '');
const fail = code => { throw Error(code); };
const readJson = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const binding = async file => ({ path: path.resolve(file), sha256: sha(await readFile(file)), bytes: (await stat(file)).size });
const sameBinding = (a, b) => normal(a?.path ?? '.') === normal(b?.path ?? '.') && a?.sha256 === b?.sha256;
const inside = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative); };
const absent = async file => { try { await stat(file); return false; } catch (error) { if (error.code === 'ENOENT') return true; throw error; } };
const tracks = ['bgm', 'sfx', 'ambience', 'accompaniment'];

export function validateDeliveryArchiveConfig(config) {
  if (config?.revision !== archiveRevision || !path.isAbsolute(config.archive_root ?? '')
    || !path.isAbsolute(config.state_root ?? '')
    || Object.keys(config).some(key => !['revision', 'archive_root', 'state_root'].includes(key)))
    fail('archive_explicit_append_only_policy_required');
  if (inside(config.state_root, config.archive_root) || inside(config.archive_root, config.state_root))
    fail('archive_local_state_must_be_separate_from_shared_archive');
  if (process.platform === 'win32' && config.state_root.startsWith('\\\\'))
    fail('archive_state_requires_local_drive');
  if (process.platform === 'win32' && path.join(config.archive_root,'0'.repeat(16),'0'.repeat(24),'0'.repeat(64)+'.source-manifest.json').length>240)
    fail('archive_path_requires_short_root_before_copy');
  if (process.platform === 'win32' && path.join(config.state_root,'0'.repeat(24),'export-reports/audio-bundle-verification.json').length>240)
    fail('archive_state_requires_short_root_before_copy');
  return { revision: archiveRevision, archive_root: path.resolve(config.archive_root), state_root: path.resolve(config.state_root) };
}

// The lease lives on the local state drive. S needs only create/read, never rename.
async function lease(file) {
  let handle;
  try { handle = await open(file, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = await readJson(file);
    if (!Number.isInteger(previous.pid) || previous.pid < 1) fail('archive_local_lease_identity_requires_attention');
    try { process.kill(previous.pid, 0); }
    catch (probe) {
      if (probe.code !== 'ESRCH') fail('archive_local_lease_owner_cannot_be_verified');
      // Two contenders can both read the dead owner before either unlinks its
      // pathname. A later unlink would then remove the first contender's new
      // lease. Do not implement non-atomic stale takeover: reconciliation is
      // explicit and only this independent archive stage remains pending.
      fail('archive_stale_lease_requires_reconciliation');
    }
    fail('archive_content_already_running');
  }
  await handle.writeFile(JSON.stringify({ pid: process.pid, revision: archiveRevision }));
  return async () => { await handle.close(); await unlink(file); };
}

async function verifySmallBinding(ref) {
  if (!path.isAbsolute(ref?.path ?? '') || !validSha(ref?.sha256)) fail('archive_binding_required');
  const actual = await binding(ref.path);
  if (actual.sha256 !== ref.sha256) fail('archive_metadata_binding_changed');
  return actual;
}

function declared(registry, file, expectedSha) {
  const row = registry.files?.find(item => normal(item.path) === normal(file) && item.sha256 === expectedSha);
  if (!row) fail('archive_closed_registry_output_binding_required');
  return row;
}

async function exactPcmMetadata(file, expectedSamples) {
  // readFile is deliberately not used for PCM. Actual full bytes/SHA are verified
  // by the existing exporter while copying and after archive/member readback.
  const { open } = await import('node:fs/promises');
  const fd = await open(file, 'r'); let header;
  try { header = Buffer.alloc(44); const read = await fd.read(header, 0, 44, 0);
    if (read.bytesRead !== 44) fail('archive_exact_pcm_header_required'); }
  finally { await fd.close(); }
  const actualBytes = (await stat(file)).size;
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE'
    || header.toString('ascii', 12, 16) !== 'fmt ' || header.readUInt32LE(16) !== 16
    || header.readUInt16LE(20) !== 1 || header.readUInt16LE(22) !== 2 || header.readUInt32LE(24) !== 48000
    || header.readUInt16LE(32) !== 6 || header.readUInt16LE(34) !== 24
    || header.toString('ascii', 36, 40) !== 'data' || actualBytes !== 44 + expectedSamples * 6
    || header.readUInt32LE(40) !== expectedSamples * 6 || header.readUInt32LE(4) + 8 !== actualBytes)
    fail('archive_exact_output_sample_contract_changed');
  return actualBytes;
}

export async function planClosedRenderArchive({ registry, config, exporterScript }) {
  const policy = validateDeliveryArchiveConfig(config);
  if (!validSha(registry?.render_id) || !path.isAbsolute(registry?.source_video?.path ?? '')
    || !validSha(registry?.source_video?.sha256) || !Array.isArray(registry.files)) fail('archive_closed_render_registry_required');
  const resultBinding = await verifySmallBinding(registry.rendered_result), result = await readJson(resultBinding.path);
  if (!path.isAbsolute(result.audio_dir ?? '') || result.source_video_sha256 !== registry.source_video.sha256
    || result.status !== registry.status) fail('archive_closed_source_or_status_changed');
  if (inside(config.archive_root, path.dirname(resultBinding.path)) || inside(resultBinding.path, config.archive_root)
    || inside(config.archive_root, result.audio_dir)) fail('archive_output_must_be_separate_from_original_job');
  if (inside(policy.state_root, path.dirname(resultBinding.path)) || inside(resultBinding.path, policy.state_root)
    || inside(policy.state_root, result.audio_dir)) fail('archive_state_must_be_separate_from_original_job');
  const reportFile = path.join(result.audio_dir, 'report.json'), reportBinding = await binding(reportFile);
  declared(registry, reportFile, reportBinding.sha256);
  const report = await readJson(reportFile), N = report.duration_samples;
  if (!Number.isSafeInteger(N) || N <= 0 || report.sample_rate !== 48000 || report.channels !== 2
    || report.bit_depth !== 24 || report.source_sha256 !== registry.source_video.sha256)
    fail('archive_source_clock_or_pcm_contract_changed');
  const audio = [];
  for (const track of tracks) {
    const file = path.join(result.audio_dir, track + '.wav'), expected = report.output_sha256?.[track];
    if (!validSha(expected)) fail('archive_four_stem_sha_required');
    declared(registry, file, expected);
    audio.push({ path: file, sha256: expected, bytes: await exactPcmMetadata(file, N),
      library: 'closed_render_delivery', asset_id: registry.render_id + '/' + track, role: track });
  }
  const sourceEvidence = [reportBinding], masterRef = result.final_mix_master ?? result.render?.final_mix_master;
  if(result.final_mix_master&&result.render?.final_mix_master
    &&(!sameBinding(result.final_mix_master.record,result.render.final_mix_master.record)
      ||!sameBinding(result.final_mix_master.final_mix,result.render.final_mix_master.final_mix)))
    fail('archive_ambiguous_owned_final_master');
  if (masterRef) {
    const ref = masterRef.record;
    const actualMaster = await verifySmallBinding(ref); declared(registry, ref.path, ref.sha256);
    const master = await readJson(ref.path);
    if (master.kind !== 'independent_technical_final_bus_master' || !sameBinding(master.inputs?.raw_report, reportBinding)
      || master.inputs?.source_sha256 !== registry.source_video.sha256 || master.duration_samples !== N
      || master.sample_rate !== 48000 || master.channels !== 2 || master.bit_depth !== 24
      || !sameBinding(master.final_mix, masterRef.final_mix)) fail('archive_bound_final_master_changed');
    if (master.inputs?.stems?.length !== 4 || audio.some(row => !master.inputs.stems.some(ref => sameBinding(row, ref))))
      fail('archive_master_stem_provenance_changed');
    declared(registry, master.final_mix.path, master.final_mix.sha256);
    audio.push({ ...master.final_mix, bytes: await exactPcmMetadata(master.final_mix.path, N),
      library: 'closed_render_delivery', asset_id: registry.render_id + '/final_mix', role: 'technical_final_mix' });
    sourceEvidence.push(actualMaster);
  }
  const exporter = await binding(exporterScript), implementation = sha(await readFile(new URL(import.meta.url)));
  const identity = { revision: archiveRevision, render_id: registry.render_id,
    source_sha256: registry.source_video.sha256, rendered_result: resultBinding,
    render_report: reportBinding, exporter, implementation_sha256: implementation, output_root: policy.archive_root,
    status: result.status, qualification_granted: false, original_outputs_modified: false,
    account_requests: 0, moves: 0, deletes: 0 };
  const manifest = { schema_version: 1, kind: 'external_frozen_audio_resource_manifest',
    purpose: 'append_only_closed_render_delivery', audio_files: audio, libraries: {},
    source_evidence_files: sourceEvidence, identity,
    qualification_granted: false, source_jobs_modified: false };
  const manifestBytes = jsonBytes(manifest), manifestSha = sha(manifestBytes);
  const archiveDirectory = path.join(policy.archive_root, registry.source_video.sha256.slice(0, 16), manifestSha.slice(0, 24));
  // The existing Python exporter creates a SHA-named frozen manifest. Reserve
  // room for Windows drive->UNC expansion rather than failing mid-copy.
  if (process.platform === 'win32' && path.join(archiveDirectory, `${manifestSha}.source-manifest.json`).length > 240)
    fail('archive_path_requires_short_root_before_copy');
  const localDirectory = path.join(policy.state_root, manifestSha.slice(0, 24));
  if (process.platform === 'win32' && path.join(localDirectory, 'export-reports/audio-bundle-verification.json').length > 240)
    fail('archive_state_requires_short_root_before_copy');
  return { identity, manifest, manifest_bytes: manifestBytes, manifest_sha256: manifestSha, local_directory: localDirectory,
    archive_directory: archiveDirectory,
    media_sha_checked_by_exporter_before_verification: true, qualification_granted: false };
}

// A separate local archive stage. Failing copy/verification never changes the
// existing render result, emits a model request or deletes an original file.
export async function archiveClosedRender({ registry, config, python, exporterScript }, options = {}) {
  const planned = await planClosedRenderArchive({ registry, config, exporterScript });
  if (!path.isAbsolute(python ?? '')) fail('archive_local_state_and_python_absolute_required');
  const local = planned.local_directory;
  const receiptFile = path.join(local, 'archive-state.json'), execute = options.execute ?? run;
  const invoke = async args => { const result = await execute(python, ['-X', 'utf8', exporterScript, ...args],
    { windowsHide: true, shell: false, encoding: 'utf8', maxBuffer: 1024 * 1024 });
    const lines = String(result.stdout).trim().split(/\r?\n/).filter(line => line.startsWith('{'));
    return JSON.parse(lines.at(-1) ?? '{}'); };
  const base = { schema_version: 1, kind: 'append_only_closed_render_archive_stage',
    revision: archiveRevision, identity: planned.identity, manifest_sha256: planned.manifest_sha256,
    archive_directory: planned.archive_directory, original_render_status: registry.status,
    account_requests: 0, deletes: 0, moves: 0, qualification_granted: false,
    blocks_inference: false, blocks_render: false, original_result_modified: false };
  const failed = error => ({ ...base, status: 'delivery_archive_failed', error: String(error.message ?? error),
    next_action: 'preserve_originals_and_inspect_archive_failure; other_independent_jobs_continue' });
  await mkdir(local, { recursive: true });
  const release = await lease(path.join(local, 'archive.lock'));
  try {
  if (!(await absent(receiptFile))) {
    const previous = await readJson(receiptFile);
    if (previous.manifest_sha256 !== planned.manifest_sha256 || JSON.stringify(previous.identity) !== JSON.stringify(planned.identity))
      fail('archive_previous_receipt_identity_changed');
    if (previous.status !== 'delivery_archive_verified') return { ...previous, no_automatic_repeat: true };
    try {
      await verifySmallBinding(previous.verification.bundle_manifest);
      if (normal(previous.verification.bundle_manifest.path) !== normal(path.join(planned.archive_directory, 'audio-bundle-manifest.json')))
        fail('archive_existing_bundle_directory_changed');
      const bundle=await readJson(previous.verification.bundle_manifest.path);
      if(bundle.kind!=='frozen_audio_handoff_bundle'||bundle.source_manifest?.sha256!==planned.manifest_sha256
        ||bundle.media_count!==planned.manifest.audio_files.length||bundle.qualification_granted!==false)
        fail('archive_existing_bundle_source_mismatch');
      await verifySmallBinding(bundle.source_manifest);
      const current = await invoke(['verify', '--manifest', previous.verification.bundle_manifest.path]);
      if (current.status !== 'verified' || current.archive_and_member_sha256_verified !== true || current.missing_resources !== 0)
        fail('archive_existing_volume_failed_full_readback');
      return { ...previous, idempotent_no_copy: true, archive_readback_reverified: true };
    } catch (error) { return { ...failed(error), prior_completed_archive_state_retained: true }; }
  }
  const manifestFile = path.join(local, 'source-manifest.json');
  if (await absent(manifestFile)) await writeFile(manifestFile, planned.manifest_bytes, { flag: 'wx' });
  else if (sha(await readFile(manifestFile)) !== planned.manifest_sha256) fail('archive_local_manifest_changed');
  let result;
  try {
    const existing = path.join(planned.archive_directory, 'audio-bundle-manifest.json');
    let verification, recovered = false;
    if (!(await absent(existing))) {
      const bundle = await readJson(existing), frozen = bundle.source_manifest;
      if (bundle.kind !== 'frozen_audio_handoff_bundle' || frozen?.sha256 !== planned.manifest_sha256
        || bundle.media_count !== planned.manifest.audio_files.length || bundle.qualification_granted !== false)
        fail('archive_existing_bundle_source_mismatch');
      await verifySmallBinding(frozen);
      const verified = await invoke(['verify', '--manifest', existing]);
      verification = { ...verified, bundle_manifest: await binding(existing), media_count: bundle.media_count,
        unique_media_sha256: bundle.unique_media_sha256, media_bytes: bundle.media_bytes, volumes: bundle.volumes };
      recovered = true;
    } else verification = await invoke(['pack', '--manifest', manifestFile, '--output', planned.archive_directory,
      '--report-dir', path.join(local, 'export-reports'), '--max-bytes', '1073741824']);
    if (verification.status !== 'verified' || verification.archive_and_member_sha256_verified !== true
      || verification.missing_resources !== 0 || verification.media_count !== planned.manifest.audio_files.length)
      fail('archive_actual_copy_readback_required');
    const SManifest = await verifySmallBinding(verification.bundle_manifest), doc = await readJson(SManifest.path);
    if (doc.source_manifest?.sha256 !== planned.manifest_sha256) fail('archive_exported_manifest_identity_changed');
    result = { ...base, status: 'delivery_archive_verified', verification,
      ...(recovered ? { recovered_completed_archive_without_copy: true } : {}) };
  } catch (error) { result = failed(error); }
  await writeFile(receiptFile, jsonBytes(result), { flag: 'wx' });
  return { ...result, local_archive_state: await binding(receiptFile) };
  } finally { await release(); }
}
