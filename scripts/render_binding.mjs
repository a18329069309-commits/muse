import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { finalMixMasterFile, verifyFinalMixMaster } from './final_mix_master.mjs';

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Bind a render to its actual inputs and delivered PCM, rather than just video duration.
export async function verifyRenderBinding(planFile, renderDirectory, report,
  { checkFinalMix = true, expectedFinalMixMaster, masterReportFile = path.join(renderDirectory, finalMixMasterFile) } = {}) {
  const binding = report.input_binding;
  if (binding?.schema_version !== 1) return ['render_binding_missing_rerender_required'];
  const planPath = path.resolve(planFile);
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const manifestPath = path.resolve(path.dirname(planPath), plan.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const files = [
    ['plan', planPath, binding.plan_sha256],
    ['manifest', manifestPath, binding.manifest_sha256],
    ['original_audio', path.resolve(path.dirname(manifestPath), manifest.original_audio), binding.original_audio_sha256],
    ['source_video', path.resolve(path.dirname(manifestPath), manifest.source_video), report.source_sha256],
    ...plan.assets.map(asset => [`asset:${asset.id}`, path.resolve(path.dirname(planPath), asset.path), binding.asset_sha256?.[asset.id]]),
    ...['bgm', 'sfx', 'ambience', 'accompaniment'].map(track => [`output:${track}`, path.join(renderDirectory, track + '.wav'), report.output_sha256?.[track]]),
  ];
  const issues = [];
  for (const [label, file, expected] of files) {
    if (!expected) { issues.push(`${label}:binding_missing`); continue; }
    try {
      if (await hashFile(file) !== expected) issues.push(`${label}:render_binding_mismatch`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      issues.push(`${label}:bound_file_missing`);
    }
  }
  if (report.source_sha256 !== manifest.source_sha256 || report.duration_samples !== manifest.timeline.duration_samples || report.sample_rate !== 48000) {
    issues.push('render_manifest_timeline_mismatch');
  }
  if (checkFinalMix && !issues.length) {
    let exists = false;
    try { await access(masterReportFile); exists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!exists && expectedFinalMixMaster !== undefined) issues.push('final_mix_master_required_but_missing');
    if (exists) {
      const verified = await verifyFinalMixMaster({ planFile, renderDirectory,
        report: await readFile(path.join(renderDirectory, 'report.json'), 'utf8').then(JSON.parse),
        expectedConfig: expectedFinalMixMaster, masterReportFile });
      issues.push(...verified.issues);
    }
  }
  return issues;
}
