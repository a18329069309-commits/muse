import path from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile, verifyRenderBinding } from './render_binding.mjs';
import { validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';

const issueKinds = new Set(['original_plus_accompaniment_digital_overload',
  'complete_mix_true_peak_at_or_above_0_dbfs', 'original_audio_kind_requires_review']);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = why => { throw Error('diagnostic_preview_delivery_' + why); };
const binding = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const matches = (a, b) => a?.sha256 === b?.sha256 && path.resolve(a?.path ?? '') === path.resolve(b?.path ?? '');

// A status read attaches an already exported, bound diagnostic preview. It does
// not regenerate audio, change a job result or claim that the raw mix is safe.
export async function readDiagnosticPreviewDelivery(receiptBinding, { sourceSha, renderBindings = [] } = {}) {
  await verifyEvidenceBindings(receiptBinding);
  const r = await readJson(receiptBinding.path);
  if (r.kind !== 'bounded_independent_diagnostic_preview_recovery' || r.schema_version !== 1
    || r.source_video_sha256 !== sourceSha || r.production_approval !== false || r.source_facts_approved !== false
    || r.raw_mix_approved !== false || r.raw_outputs_modified !== false || r.editing_or_music_changed !== false
    || r.relative_balance_changed !== false || r.actual_listening_review !== 'not_performed'
    || r.account_calls !== 0 || r.encoded_technical_status !== 'technical_ok'
    || !Number.isSafeInteger(r.duration_samples) || r.duration_samples <= 0
    || !Number.isFinite(r.preview_master_gain_db) || r.preview_master_gain_db < -6 || r.preview_master_gain_db > 0)
    fail('restricted_receipt_required');
  for (const item of [r.raw_plan, r.raw_report]) if (!renderBindings.some(known => matches(known, item)))
    fail('original_registered_render_required');
  await verifyEvidenceBindings([r.trial, r.raw_plan, r.raw_report, r.preview, r.encoded_report]);
  const [trial, plan, raw, encoded] = await Promise.all([r.trial, r.raw_plan, r.raw_report, r.encoded_report].map(item => readJson(item.path)));
  if (trial.source_video_sha256 !== sourceSha || trial.production_approval !== false
    || trial.duration_samples !== r.duration_samples || trial.purpose !== 'technical_diagnostic'
    || trial.render?.purpose !== 'technical_diagnostic' || trial.render.production_approval !== false
    || trial.render.source_policy?.authorization?.sha256 !== r.source_policy?.authorization?.sha256
    || !path.isAbsolute(trial.audio_dir ?? '')) fail('original_trial_changed');
  await validateIndependentMusicPackPolicy({ mode: 'research', automatic_trial: true,
    material_strategy: 'independent_music_packs', source_policy: r.source_policy,
    trial_review_policy: 'diagnostic_candidates', output_dir: path.dirname(r.preview.path) },
  { outputDirectory: path.dirname(r.preview.path), operation: 'export_preview' });
  if (raw.source_sha256 !== sourceSha || raw.duration_samples !== r.duration_samples || raw.sample_rate !== 48000
    || !['technical_ok', 'needs_mix_review'].includes(raw.status) || !Array.isArray(raw.issues)
    || raw.issues.some(issue => !issueKinds.has(issue)) || raw.status !== r.original_raw_mix_status
    || !same(raw.issues, r.original_raw_mix_issues)) fail('raw_mix_status_changed');
  if (raw.status === 'technical_ok' && raw.issues.length) fail('raw_mix_status_changed');
  for (const track of ['bgm', 'sfx', 'ambience', 'accompaniment'])
    if (raw.output_sample_peaks_before_pcm_clamping?.[track]?.clipped !== false) fail('upstream_stem_overload');
  const problems = await verifyRenderBinding(r.raw_plan.path, trial.audio_dir, raw);
  if (problems.length) fail('original_render_binding_changed:' + problems.join(','));
  const manifest = await readJson(path.resolve(path.dirname(r.raw_plan.path), plan.manifest));
  if (manifest.source_sha256 !== sourceSha || manifest.timeline?.duration_samples !== r.duration_samples)
    fail('source_clock_changed');
  if (encoded.source_sha256 !== sourceSha || encoded.duration_samples !== r.duration_samples
    || encoded.production_approval !== false || encoded.review_only !== true
    || encoded.encoded_technical_status !== 'technical_ok' || encoded.faststart_verified !== true
    || encoded.lightweight_preview_status !== 'within_size_limit' || encoded.display_aspect_preserved !== true
    || !Number.isFinite(encoded.encoded_true_peak_dbfs) || encoded.encoded_true_peak_dbfs >= 0
    || encoded.preview_mastering?.gain_db !== r.preview_master_gain_db
    || encoded.preview_mastering?.applied_to_preview_only !== true
    || encoded.preview_mastering?.stem_files_modified !== false
    || encoded.preview_mastering?.relative_dialogue_music_balance_changed !== false)
    fail('encoded_report_changed');
  if ((await stat(r.preview.path)).size !== encoded.preview_size_bytes) fail('encoded_file_size_changed');
  const preview = { ...r.preview };
  return { delivery_state: 'preview_available_pending_audition', preview, receipt: receiptBinding,
    duration_samples: r.duration_samples, original_render_status: raw.status,
    raw_mix_review_pending: true, raw_mix_issues: [...raw.issues],
    unresolved: [...(trial.unresolved ?? [])], production_approval: false,
    actual_audio_listened: false, source_facts_approved: false, qualified: false,
    original_job_status_changed: false, model_calls: 0, render_calls: 0 };
}

export async function discoverDiagnosticPreviewDeliveries({ episodeDirectory, sourceSha, renderBindings = [] }) {
  const receipts = [], gaps = [];
  // Only inspect this job's render subtree; no corpus/media/model directory scan.
  async function visit(directory, depth = 0) {
    if (depth > 4 || receipts.length >= 32) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const item of entries) {
      if (receipts.length >= 32) break;
      const file = path.join(directory, item.name);
      if (item.isFile() && item.name === 'preview-recovery-receipt.json') receipts.push(file);
      else if (item.isDirectory() && !['media', 'frames'].includes(item.name)) await visit(file, depth + 1);
    }
  }
  await visit(path.join(episodeDirectory, 'render'));
  const deliveries = [];
  for (const file of receipts) {
    try {
      const delivery = await readDiagnosticPreviewDelivery(await binding(file), { sourceSha, renderBindings });
      if (!deliveries.some(row => row.preview.sha256 === delivery.preview.sha256)) deliveries.push(delivery);
    } catch (error) { gaps.push({ receipt_file: file, reason: error.message }); }
  }
  return { deliveries, gaps, inference_calls: 0, render_calls: 0, job_state_modified: false };
}
