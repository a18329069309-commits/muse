import { projectTrialPreflight } from './project_trial_gate.mjs';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { verifyRenderBinding } from './render_binding.mjs';
import { finalMixMasterFile, verifyFinalMixMaster } from './final_mix_master.mjs';

const execute = promisify(execFile);
const run = (command, args) => execute(command, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
const [planName, renderFlag, renderName, outFlag, outputName, ...extra] = process.argv.slice(2);
const previewLimitBytes = 30 * 1024 * 1024, audioBitrate = 192000;

function previewOptions(args) {
  let reviewOnly = false, assistedReviewOnly = false, masterGainDb = 0, masterSpecified = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--review-only' && !reviewOnly) reviewOnly = true;
    else if (args[i] === '--assisted-review-only' && !assistedReviewOnly) assistedReviewOnly = true;
    else if (args[i] === '--preview-master-gain-db' && !masterSpecified) {
      masterSpecified = true; masterGainDb = Number(args[++i]);
      if (!Number.isFinite(masterGainDb) || masterGainDb < -12 || masterGainDb > 0)
        throw new Error('Preview master gain must be between -12 and 0 dB');
    } else throw new Error('Unknown or duplicate preview option');
  }
  if (reviewOnly && assistedReviewOnly || masterSpecified && !reviewOnly)
    throw new Error('Preview-only master gain requires explicit --review-only');
  return { reviewOnly, assistedReviewOnly, masterGainDb, masterSpecified };
}

function displayAspect(stream) {
  const [numerator, denominator] = (stream.sample_aspect_ratio ?? '1:1').split(':').map(Number);
  const aspect = stream.width / stream.height * (numerator > 0 && denominator > 0 ? numerator / denominator : 1);
  const rotation = Number(stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0);
  return Math.abs(rotation % 180) === 90 ? 1 / aspect : aspect;
}

async function faststart(file, bytes) {
  const stream = await open(file, 'r'), header = Buffer.alloc(16);
  let offset = 0, moov = false;
  try {
    while (offset + 8 <= bytes) {
      const { bytesRead } = await stream.read(header, 0, 16, offset);
      let size = header.readUInt32BE(0);
      if (size === 1) { if (bytesRead < 16) return false; size = Number(header.readBigUInt64BE(8)); }
      if (size === 0) size = bytes - offset;
      if (!Number.isSafeInteger(size) || size < 8 || offset + size > bytes) return false;
      const type = header.toString('ascii', 4, 8);
      if (type === 'moov') moov = true;
      if (type === 'mdat') return moov;
      offset += size;
    }
    return false;
  } finally { await stream.close(); }
}

async function main() {
  const projectGate = await projectTrialPreflight({ output_dir: outputName }, { operation: 'export_preview', inputFiles: planName ? [path.resolve(planName)] : [] });
  if (projectGate) { console.log(JSON.stringify(projectGate)); process.exitCode = 3; return; }

  const { reviewOnly, assistedReviewOnly, masterGainDb, masterSpecified } = previewOptions(extra);
  if (!planName || renderFlag !== '--render' || !renderName || outFlag !== '--out' || !outputName) {
    throw new Error('Usage: node export_preview.mjs PLAN --render RENDER_DIRECTORY --out NEW_PREVIEW.mp4 [--review-only]');
  }
  const planPath = path.resolve(planName), renderPath = path.resolve(renderName), output = path.resolve(outputName);
  if (path.extname(output).toLowerCase() !== '.mp4') throw new Error('Preview output must be MP4');
  for (const file of [output, `${output}.json`]) {
    try { await access(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('Preview or report already exists; choose a new output path');
  }
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const manifestPath = path.resolve(path.dirname(planPath), plan.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const report = JSON.parse(await readFile(path.join(renderPath, 'report.json'), 'utf8'));
  let finalMix;
  const finalReportFile = path.join(renderPath, finalMixMasterFile);
  let finalReportExists = false;
  try { await access(finalReportFile); finalReportExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (finalReportExists) {
    if (masterSpecified) throw new Error('Verified final mix cannot receive a second preview master gain');
    const verified = await verifyFinalMixMaster({ planFile: planPath, renderDirectory: renderPath, report, masterReportFile: finalReportFile });
    if (verified.issues.length) throw new Error('Final mix binding changed: ' + verified.issues.join(', '));
    finalMix = verified;
  }
  const sourceReviewOnly = reviewOnly && report.status === 'needs_mix_review' &&
    report.issues?.length === 1 && report.issues[0] === 'original_audio_kind_requires_review';
  const assistedFactsPending = assistedReviewOnly && report.status === 'needs_mix_review' && report.issues?.length
    && report.issues.every(issue => ['original_audio_kind_requires_review', 'dialogue_intervals_not_provided'].includes(issue));
  const safeMasterIssues = ['original_plus_accompaniment_digital_overload', 'complete_mix_true_peak_at_or_above_0_dbfs',
    'original_audio_kind_requires_review', 'dialogue_intervals_not_provided'];
  const rawTruePeak = report.complete_mix?.true_peak_dbfs;
  const finalMixReviewOnly = finalMix && (reviewOnly || assistedReviewOnly)
    && report.status === 'needs_mix_review' && report.issues?.length
    && report.issues.every(issue => safeMasterIssues.includes(issue));
  const masteredReviewOnly = reviewOnly && masterSpecified && masterGainDb < 0
    && report.status === 'needs_mix_review' && report.issues?.length
    && report.issues.every(issue => safeMasterIssues.includes(issue))
    && Number.isFinite(rawTruePeak) && rawTruePeak + masterGainDb <= -1
    && report.output_sample_peaks_before_pcm_clamping
    && Object.values(report.output_sample_peaks_before_pcm_clamping).every(peak => peak.clipped === false);
  if (report.status !== 'technical_ok' && !sourceReviewOnly && !assistedFactsPending && !masteredReviewOnly && !finalMixReviewOnly)
    throw new Error('Render requires mix review; correct it before exporting');
  const bindingIssues = await verifyRenderBinding(planPath, renderPath, report);
  if (bindingIssues.length) throw new Error('Render inputs or delivered tracks changed; rerender before exporting: ' + bindingIssues.join(', '));
  if (manifest.analysis_window || report.source_sha256 !== manifest.source_sha256 ||
      report.duration_samples !== manifest.timeline.duration_samples || report.sample_rate !== 48000) {
    throw new Error('Render and full-episode manifest do not match');
  }
  const source = path.resolve(path.dirname(manifestPath), manifest.source_video);
  const original = path.resolve(path.dirname(manifestPath), manifest.original_audio);
  const accompaniment = path.join(renderPath, 'accompaniment.wav');
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(source)) digest.update(chunk);
  if (digest.digest('hex') !== manifest.source_sha256) throw new Error('Source video SHA-256 mismatch');
  const duration = report.duration_samples / 48000;
  const videoBitrate = Math.floor(Math.min(1500000, previewLimitBytes * 8 * 0.9 / duration - audioBitrate) / 1000) * 1000;
  if (!Number.isFinite(duration) || duration <= 0 || videoBitrate <= 0)
    throw new Error('Full preview duration cannot fit the 30 MiB audio/video budget');
  const firstPts = manifest.video.first_pts_seconds;
  if (!Number.isFinite(firstPts)) throw new Error('Video first PTS is missing');
  const sourceProbe = JSON.parse((await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_streams', '-of', 'json', source])).stdout);
  const sourceAspect = displayAspect(sourceProbe.streams[0]);
  await mkdir(path.dirname(output), { recursive: true });
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-copyts', '-itsoffset', String(-firstPts),
    '-i', source, ...(finalMix ? ['-i', finalMix.master.final_mix.path] : ['-i', original, '-i', accompaniment]),
    '-filter_complex', `[0:v:0]scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1[picture];` +
      (finalMix ? `[1:a:0]atrim=end_sample=${report.duration_samples},asetpts=PTS-STARTPTS[mixed]`
        : `[1:a:0][2:a:0]amix=inputs=2:normalize=0:duration=first,volume=${masterGainDb}dB,atrim=end_sample=${report.duration_samples},asetpts=PTS-STARTPTS[mixed]`),
    '-map', '[picture]', '-map', '[mixed]', '-c:v', 'libx264', '-preset', 'fast', '-pix_fmt', 'yuv420p',
    '-b:v', String(videoBitrate), '-maxrate:v', String(videoBitrate), '-bufsize:v', String(videoBitrate * 2),
    '-threads:v', '2', '-fps_mode:v', 'passthrough', '-c:a', 'aac', '-b:a', String(audioBitrate), '-ar', '48000',
    '-t', String(duration), '-avoid_negative_ts', 'disabled', '-movflags', '+faststart', output]);
  const probe = JSON.parse((await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output])).stdout);
  const video = probe.streams.find(stream => stream.codec_type === 'video');
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  const previewBytes = (await stat(output)).size, sizeOk = previewBytes <= previewLimitBytes;
  const faststartOk = await faststart(output, previewBytes);
  const aspectOk = video && Math.abs(displayAspect(video) - sourceAspect) <= 2 / Math.min(video.width, video.height);
  const measured = (await run('ffmpeg', ['-hide_banner', '-nostats', '-i', output, '-map', '0:a:0',
    '-af', 'ebur128=peak=true', '-f', 'null', '-'])).stderr;
  const summary = measured.slice(measured.lastIndexOf('Summary:'));
  const truePeakText = summary.match(/Peak:\s*([-+\d.]+|[-+]?inf)\s+dBFS/i)?.[1];
  const truePeak = Number(truePeakText);
  if (truePeakText === undefined) throw new Error('Encoded preview true peak was not reported');
  const timingOk = video && audio && Number(audio.sample_rate) === 48000 &&
    Math.abs(Number(video.start_time)) <= 1 / 48000 &&
    Math.abs(Number(audio.start_time)) <= 1 / 48000 &&
    Math.abs(Number(video.duration) - duration) <= 1 / 48000 &&
    Math.abs(Number(audio.duration) - duration) <= 1 / 48000;
  const finalPeakOk = finalMix && (Number.isFinite(truePeak) ? truePeak + 0.05 <= finalMix.master.config.target_true_peak_dbtp
    : truePeak === -Infinity && finalMix.master.sample_peak_before_pcm_clamping.silence);
  const technicalState = timingOk && (finalMix ? finalPeakOk : truePeak < 0)
    && video.codec_name === 'h264' && audio.codec_name === 'aac'
    && aspectOk && faststartOk ? 'technical_ok' : 'needs_mix_review';
  const state = !sizeOk ? 'needs_preview_review'
    : technicalState === 'technical_ok' && (sourceReviewOnly || assistedFactsPending || masteredReviewOnly || finalMixReviewOnly) ? 'review_only_source_pending' : technicalState;
  await writeFile(`${output}.json`, `${JSON.stringify({ schema_version: 1, status: state,
    encoded_technical_status: technicalState, review_only: reviewOnly || assistedReviewOnly,
    assisted_source_facts_pending: Boolean(assistedFactsPending),
    upstream_mix_status: report.status, upstream_mix_issues: report.issues ?? [], production_approval: false,
    ...(finalMix ? { final_mix_master: { report: finalMix.report, final_mix: finalMix.master.final_mix,
      revision: finalMix.master.config.revision, consumed_once: true, original_audio_added_again: false,
      second_master_gain_applied: false, production_approval: false } } : {}),
    preview_mastering: { operation: finalMix ? 'consume_verified_uniform_final_bus_once' : 'uniform_gain_after_original_plus_accompaniment',
      gain_db: finalMix ? finalMix.master.mastering.gain_db : masterGainDb,
      explicitly_requested: finalMix ? true : masterSpecified, applied_to_preview_only: !finalMix, stem_files_modified: false,
      relative_dialogue_music_balance_changed: false, upstream_unmastered_true_peak_dbfs: rawTruePeak ?? null,
      upstream_unmastered_mix_qualified: false },
    source_sha256: manifest.source_sha256, composition: finalMix ? 'verified final bus once; original already included once' : 'prepared original once + accompaniment once',
    video_processing: 'H.264 transcode within 1280-pixel bounds; display aspect retained; first video PTS mapped to zero',
    video_codec: video?.codec_name, audio_codec: audio?.codec_name,
    display_dimensions: video ? [video.width, video.height] : null, display_aspect_preserved: Boolean(aspectOk),
    preview_size_bytes: previewBytes, preview_size_limit_bytes: previewLimitBytes,
    lightweight_preview_status: sizeOk ? 'within_size_limit' : 'size_limit_exceeded',
    video_bitrate_budget_bps: videoBitrate, audio_bitrate_bps: audioBitrate, faststart_verified: faststartOk,
    duration_samples: report.duration_samples, duration_seconds: duration,
    video_duration_seconds: Number(video?.duration), audio_duration_seconds: Number(audio?.duration),
    encoded_true_peak_dbfs: Number.isFinite(truePeak) ? truePeak : null,
    creative_review: 'not_performed', audible_sync_review: 'not_performed',
    intended_use: finalMix ? 'audition of derived technical final bus; raw mix, source facts and creative acceptance remain pending'
      : sourceReviewOnly || masteredReviewOnly ? 'restricted audition; original source content and creative acceptance pending; raw stems require the recorded mix headroom'
      : 'audition; technical_ok does not establish creative acceptance'
  }, null, 2)}\n`, 'utf8');
  console.log(`${state}; preview exported; creative review not performed`);
  if (technicalState !== 'technical_ok' || !sizeOk) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof SyntaxError ? 'Invalid JSON in plan, manifest or report'
    : error.code ? `Preview export failed (${error.code})` : error.message);
  process.exitCode = 1;
});
