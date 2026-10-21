import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { readJson, saveJson } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';
import {inspectLocalResearchExecution,executeLocalResearch} from './local_research_execution.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export function validateLocalResearchResults({ transcript, activity, report, identity, duration }) {
  for (const row of [transcript, activity, report]) {
    for (const [key, value] of Object.entries(identity)) if (row[key] !== value) throw new Error('local_research_audio_identity_changed');
  }
  if (!Array.isArray(transcript.segments) || !Array.isArray(activity.dialogue_intervals)) throw new Error('local_research_audio_outputs_missing');
  if (report.asr_chunks !== transcript.segments.length || report.vad_intervals !== activity.dialogue_intervals.length)
    throw new Error('local_research_audio_report_counts_mismatch');
  let coverageEnd = 0;
  for (const row of transcript.segments) {
    if (!Number.isFinite(row.chunk_start_seconds) || !Number.isFinite(row.chunk_end_seconds)
      || row.chunk_start_seconds < 0 || row.chunk_end_seconds <= row.chunk_start_seconds || row.chunk_end_seconds > duration
      || typeof row.text !== 'string') throw new Error('local_research_transcript_range_invalid');
    if (row.chunk_start_seconds > coverageEnd + 1 / 16000) throw new Error('local_research_time_coverage_incomplete');
    coverageEnd = Math.max(coverageEnd, row.chunk_end_seconds);
  }
  if (Math.abs(coverageEnd - duration) > 1 / 16000) throw new Error('local_research_time_coverage_incomplete');
  let previousEnd = 0;
  for (const row of activity.dialogue_intervals) {
    if (!Number.isFinite(row.start_seconds) || !Number.isFinite(row.end_seconds) || row.start_seconds < previousEnd
      || row.end_seconds <= row.start_seconds || row.end_seconds > duration) throw new Error('local_research_activity_range_invalid');
    previousEnd = row.end_seconds;
  }
}

// Reuse the installed offline analysis script; neither transcript nor VAD grants hearing approval.
export async function prepareLocalResearchEvidence({ options, python, manifestPath, outputDirectory },executionContext={}) {
  await inspectLocalResearchExecution(executionContext,'local_research_asr_preflight');
  if (!options?.model_dir || options.device && options.device !== 'cpu') throw new Error('local_research_existing_cpu_model_required');
  const manifest = await readJson(manifestPath), base = path.dirname(manifestPath);
  const duration = manifest.timeline.duration_samples / 48000;
  const identity = { source_video_sha256: manifest.source_sha256, manifest_sha256: await hashFile(manifestPath),
    original_audio_sha256: await hashFile(path.resolve(base, manifest.original_audio)),
    analysis_audio_sha256: await hashFile(path.resolve(base, manifest.analysis_audio)) };
  await inspectLocalResearchExecution(executionContext,'local_research_asr_identity_io');
  await mkdir(outputDirectory, { recursive: true });
  const raw = path.join(outputDirectory, 'raw');
  await executeLocalResearch(options.python ?? python, ['-B', '-X', 'utf8', path.join(here, 'analyze_local_audio.py'),
    '--manifest', manifestPath, '--model-dir', path.resolve(options.model_dir), '--out', raw, '--device', 'cpu',
    '--language', options.language ?? 'auto'], { timeout: options.timeout_ms ?? 300000, maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...(options.module_directory ? { PYTHONPATH: path.resolve(options.module_directory) } : {}),
      HF_HUB_OFFLINE: '1', MODELSCOPE_OFFLINE: '1', HF_HUB_DISABLE_TELEMETRY: '1' } },executionContext,'local_research_asr');
  const transcriptFile = path.join(raw, 'transcript.json'), activityFile = path.join(raw, 'dialogue-activity.json');
  const transcript = await readJson(transcriptFile), activity = await readJson(activityFile), report = await readJson(path.join(raw, 'analysis-report.json'));
  validateLocalResearchResults({ transcript, activity, report, identity, duration });
  const rawReferences = await Promise.all([transcriptFile, activityFile].map(async file => ({ path: file, sha256: await hashFile(file) })));
  const observations = [];
  for (const [index, row] of transcript.segments.entries()) {
    const sourceRange = [row.chunk_start_seconds, row.chunk_end_seconds];
    const file = path.join(outputDirectory, `observation-${String(index + 1).padStart(3, '0')}.json`);
    await saveJson(file, { schema_version: 1, ...identity, source_range: sourceRange, model: 'SenseVoiceSmall',
      model_sha256: transcript.model_sha256, package_versions: transcript.package_versions,
      transcription_prediction: row.text, transcription_verified: false, sound_facts_qualified: false,
      dialogue_activity_model: 'silero-vad', dialogue_activity_verified: false,
      dialogue_activity_prediction: activity.dialogue_intervals.filter(r => r.end_seconds > sourceRange[0] && r.start_seconds < sourceRange[1]),
      timestamp_precision: 'source_chunks_and_speech_activity_not_words_or_actions',
      original_audio_kind: 'unknown', raw_references: rawReferences, artistic_approval: false });
    observations.push(file);
  }
  const receipt = await saveJson(path.join(outputDirectory, 'receipt.json'), { schema_version: 1, ...identity,
    model_sha256: transcript.model_sha256, package_versions: transcript.package_versions, raw_references: rawReferences,
    observation_files: observations, dialogue_intervals: activity.dialogue_intervals, cpu_only: true,
    audio_seconds_processed: duration, actual_asr_chunks: transcript.segments.length, local_network_requests: false,
    sound_facts_qualified: false, artistic_approval: false, actual_analysis_status: report.status });
  await inspectLocalResearchExecution(executionContext,'local_research_asr_complete_io');
  return { observationFiles: observations, dialogueIntervals: activity.dialogue_intervals, receipt };
}
