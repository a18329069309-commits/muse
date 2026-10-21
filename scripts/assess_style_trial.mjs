import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const execute = promisify(execFile);
const json = async file => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const forms = new Set(['instrumental', 'wordless_vocal', 'short_lyrics', 'spoken_adlib', 'unknown']);
const rangeValid = range => range && Number.isFinite(range.start_seconds)
  && Number.isFinite(range.end_seconds) && range.start_seconds >= 0 && range.end_seconds > range.start_seconds;

// Validates real inputs and honest next actions. It never grants artistic acceptance.
export async function assessStyleTrial(trialFile) {
  const base = path.dirname(path.resolve(trialFile));
  const report = { schema_version: 1, status: 'invalid_trial', structure_valid: false,
    candidates_ready: false, issues: [], gaps: [], warnings: [], candidates: [],
    artistic_acceptance: 'not_assessed', production_approval: false, next_candidate_id: null,
    content_review_scope: 'records_checked_not_independently_listened',
    model_calls: 0, cloud_uploads: 0 };
  const issue = (code, id) => report.issues.push({ code, ...(id ? { candidate_id: id } : {}) });
  const gap = (code, id) => report.gaps.push({ code, ...(id ? { candidate_id: id } : {}) });
  const bind = async (record, label) => {
    if (!record || typeof record.path !== 'string' || !record.path
      || !/^[a-f0-9]{64}$/i.test(record.sha256 ?? '')) throw new Error(`${label}_binding_required`);
    const file = path.resolve(base, record.path);
    if (!(await stat(file)).isFile()) throw new Error(`${label}_not_file`);
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    if (hash !== record.sha256.toLowerCase()) throw new Error(`${label}_hash_mismatch`);
    return { path: file, sha256: hash };
  };
  const duration = async (file, type) => {
    const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', `${type}:0`,
      '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file],
    { windowsHide: true, maxBuffer: 1024 * 1024 });
    const media = JSON.parse(stdout), seconds = Number(media.format?.duration);
    if (!media.streams?.length || !Number.isFinite(seconds) || seconds <= 0) throw new Error(`invalid_${type}_media`);
    return seconds;
  };
  let trial, video, window;
  try {
    trial = await json(trialFile);
    if (trial.schema_version !== 1) throw new Error('unsupported_schema');
    if (!['style', 'arrangement'].includes(trial.policy?.comparison)
      || !['director_auto', 'user_choose'].includes(trial.policy?.selection)
      || typeof trial.policy?.require_music_words !== 'boolean') throw new Error('invalid_policy');
    window = trial.video?.window;
    if (!rangeValid(window)) throw new Error('invalid_video_window');
    video = await bind(trial.video, 'video');
    if (window.end_seconds > await duration(video.path, 'v') + .001) throw new Error('video_window_out_of_range');
    const analysisFile = await bind(trial.analysis, 'analysis');
    const analysis = await json(analysisFile.path);
    if (analysis.source_video_sha256 !== video.sha256) throw new Error('analysis_video_identity_mismatch');
    report.video = { ...video, window };
    report.analysis = analysisFile;
    report.policy = trial.policy;
    if (!Array.isArray(trial.candidates) || trial.candidates.length < 2) throw new Error('two_comparison_candidates_required');
  } catch (error) {
    issue(error.code ? `input_file_or_tool_error_${error.code}` : error.message);
    return report;
  }
  const ids = new Set();
  for (const candidate of trial.candidates) {
    const id = candidate?.id;
    try {
      if (typeof id !== 'string' || !id || ids.has(id)) throw new Error('missing_or_duplicate_candidate_id');
      ids.add(id);
      if (!forms.has(candidate.music_form)) throw new Error('invalid_music_form');
      if (!rangeValid(candidate.source?.range)) throw new Error('invalid_source_range');
      if (typeof candidate.source.family !== 'string' || !candidate.source.family) throw new Error('source_family_required');
      const source = await bind(candidate.source, 'source');
      if (candidate.source.range.end_seconds > await duration(source.path, 'a') + .001) throw new Error('source_range_out_of_range');
      const audition = await bind(candidate.audition, 'audition');
      const auditionSeconds = await duration(audition.path, 'a');
      if (Math.abs(auditionSeconds - (window.end_seconds - window.start_seconds)) > .05) throw new Error('audition_window_duration_mismatch');
      if (!['verified', 'pending', 'rejected'].includes(candidate.content_review?.status)) throw new Error('invalid_content_review');
      let contentRecordVerified = false;
      if (candidate.content_review.status === 'verified') {
        const evidenceFile = await bind(candidate.content_review.evidence, 'content_evidence');
        const evidence = await json(evidenceFile.path), range = evidence.source_range_seconds;
        if (evidence.source_sha256 !== source.sha256 || evidence.music_form !== candidate.music_form
          || !Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)
          || range[0] > candidate.source.range.start_seconds || range[1] < candidate.source.range.end_seconds
          || typeof evidence.observation !== 'string' || !evidence.observation.trim()) throw new Error('content_evidence_not_bound_to_selected_source');
        contentRecordVerified = true;
      }
      if (candidate.content_review.status === 'rejected') gap('rejected_candidate_content', id);
      if (candidate.music_form === 'unknown') report.warnings.push({ code: 'music_form_unknown', candidate_id: id });
      if (!contentRecordVerified) report.warnings.push({ code: 'content_listening_pending', candidate_id: id });
      report.candidates.push({ id, source: { ...source, range: candidate.source.range, family: candidate.source.family },
        audition: { ...audition, duration_seconds: auditionSeconds }, music_form: candidate.music_form,
        content_record_verified: contentRecordVerified, listening_acceptance: 'not_assessed' });
    } catch (error) {
      issue(error.code ? `candidate_file_or_tool_error_${error.code}` : error.message, id);
    }
  }
  report.structure_valid = report.issues.length === 0;
  if (!report.structure_valid) return report;
  for (let a = 0; a < report.candidates.length; a++) for (let b = a + 1; b < report.candidates.length; b++) {
    const left = report.candidates[a], right = report.candidates[b];
    if (trial.policy.comparison === 'style' && (left.source.sha256 === right.source.sha256 || left.source.family === right.source.family)) {
      gap('same_source_or_family_is_not_style_comparison', `${left.id},${right.id}`);
    }
  }
  if (trial.policy.require_music_words && !report.candidates.some(c => ['short_lyrics', 'spoken_adlib'].includes(c.music_form) && c.content_record_verified)) {
    gap('verified_music_words_candidate_missing');
  }
  const recommendation = trial.recommended_candidate_id;
  if (!ids.has(recommendation)) issue('valid_director_recommendation_required');
  if (trial.selected_candidate_id != null && !ids.has(trial.selected_candidate_id)) issue('selected_candidate_missing');
  const chosenId = trial.selected_candidate_id ?? (trial.policy.selection === 'director_auto' ? recommendation : null);
  const chosen = report.candidates.find(candidate => candidate.id === chosenId);
  if (trial.policy.require_music_words && chosen
    && (!['short_lyrics', 'spoken_adlib'].includes(chosen.music_form) || !chosen.content_record_verified)) {
    gap('chosen_music_words_candidate_missing', chosenId);
  }
  report.structure_valid = report.issues.length === 0;
  report.candidates_ready = report.structure_valid && report.gaps.length === 0;
  report.recommended_candidate_id = recommendation ?? null;
  report.selected_candidate_id = trial.selected_candidate_id ?? null;
  if (!report.structure_valid) return report;
  if (!report.candidates_ready) {
    report.status = 'candidate_gaps'; report.next_action = 'replace_or_acquire_missing_candidates';
  } else if (trial.policy.selection === 'user_choose' && !trial.selected_candidate_id) {
    report.status = 'awaiting_user_selection'; report.next_action = 'present_actual_short_auditions';
  } else {
    report.status = 'ready_for_short_audition'; report.next_action = 'audition_recommended_or_selected_candidate';
    report.next_candidate_id = trial.selected_candidate_id ?? recommendation;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, flag, output, ...extra] = process.argv.slice(2);
  if (!input || extra.length || (flag !== undefined && (flag !== '--out' || !output))) {
    console.error('Usage: node assess_style_trial.mjs TRIAL.json [--out REPORT.json]'); process.exitCode = 1;
  } else {
    assessStyleTrial(input).then(async report => {
      const serialized = JSON.stringify(report, null, 2) + '\n';
      if (output) await writeFile(output, serialized, 'utf8');
      else process.stdout.write(serialized);
      process.exitCode = report.structure_valid ? 0 : 2;
    }).catch(() => { console.error('Style trial assessment failed'); process.exitCode = 1; });
  }
}
