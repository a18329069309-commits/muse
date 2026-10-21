import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {executeLocalResearch,inspectLocalResearchExecution} from './local_research_execution.mjs';

const sampleRate = 48000;

async function run(command, args, context) {
  const { stdout } = await executeLocalResearch(command, args, {
    windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  },context,command==='ffprobe'?'prepare_media_probe':'prepare_media_decode');
  return stdout;
}

function parseArgs(args) {
  const options = { step: 2, start: 0, noAudio: false, window: false };
  options.video = args.shift();
  if (!options.video || options.video.startsWith('--')) throw new Error('A local video is required.');
  while (args.length) {
    const flag = args.shift();
    if (flag === '--no-audio') { options.noAudio = true; continue; }
    const key = { '--out': 'out', '--step': 'step', '--start': 'start', '--end': 'end' }[flag];
    if (!key || !args.length || args[0].startsWith('--')) throw new Error(`Invalid option: ${flag}`);
    const value = args.shift();
    options[key] = key === 'out' ? value : Number(value);
    if (key === 'start' || key === 'end') options.window = true;
  }
  if (!options.out) throw new Error('--out OUTPUT is required.');
  for (const key of ['start', 'step', 'end']) {
    if (options[key] !== undefined && !Number.isFinite(options[key])) throw new Error(`${key} must be finite.`);
  }
  if (options.start < 0 || options.step <= 0) throw new Error('start must be nonnegative and step must be positive.');
  return options;
}

function seconds(integer, decimal, timeBase) {
  if (integer !== undefined && integer !== 'N/A' && Number.isFinite(Number(integer))) {
    return Number(integer) * timeBase;
  }
  return Number(decimal);
}

export async function prepareEpisode(options) {
  const context={trialBudget:options.trialBudget,deadlineAtMs:options.deadlineAtMs,
    ownedProcessPython:options.ownedProcessPython??options.python};
  await inspectLocalResearchExecution(context,'prepare_media_io_admission');
  const executeMedia=(command,args)=>run(command,args,context);
  const source = path.resolve(options.video);
  const output = path.resolve(options.out);
  if (!(await stat(source)).isFile()) throw new Error('Input must be a local file.');
  let existing;
  try { existing = await readdir(output); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing?.length) throw new Error('Output directory must be empty; use a new directory.');
  const [metadataText, framesText] = await Promise.all([
    executeMedia('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', source]),
    executeMedia('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp,best_effort_timestamp_time,duration,duration_time,pkt_duration,pkt_duration_time',
      '-of', 'json', source]),
  ]);
  const metadata = JSON.parse(metadataText);
  const video = metadata.streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('Input has no video stream.');
  const [numerator, denominator] = video.time_base.split('/').map(Number);
  const timeBase = numerator / denominator;
  const frames = JSON.parse(framesText).frames.map((frame, index) => ({
    index,
    pts: seconds(frame.best_effort_timestamp, frame.best_effort_timestamp_time, timeBase),
    duration: seconds(frame.duration ?? frame.pkt_duration, frame.duration_time ?? frame.pkt_duration_time, timeBase),
  }));
  if (!frames.length || frames.some((frame, index) => !Number.isFinite(frame.pts)
    || (index && frame.pts <= frames[index - 1].pts))) {
    throw new Error('Video requires readable, strictly increasing frame PTS.');
  }
  const first = frames[0].pts;
  const last = frames.at(-1);
  let end = last.pts + last.duration;
  if (!(last.duration > 0)) {
    const streamStart = seconds(video.start_pts, video.start_time, timeBase);
    const streamDuration = seconds(video.duration_ts, video.duration, timeBase);
    end = streamStart + streamDuration;
    if (!(end > last.pts)) throw new Error('Cannot determine the final visible frame duration.');
  }
  const duration = end - first;
  const durationSamples = Math.round(duration * sampleRate);
  if (!Number.isSafeInteger(durationSamples) || durationSamples <= 0) throw new Error('Invalid video duration.');
  const start = options.start ?? 0;
  const stop = options.end ?? duration;
  const step = options.step ?? 2;
  if (!(step > 0) || !Number.isFinite(step) || !Number.isFinite(start) || !Number.isFinite(stop)
    || start < 0 || start >= stop || stop > duration + 1 / sampleRate) {
    throw new Error('Frame window must satisfy 0 <= start < end <= video duration.');
  }
  // Select the frame visible at each requested instant, then record its actual PTS.
  const selected = [];
  let frameIndex = 0;
  for (let request = start; request < Math.min(stop, duration); request += step) {
    while (frameIndex + 1 < frames.length && frames[frameIndex + 1].pts - first <= request + 1e-9) frameIndex++;
    if (selected.at(-1)?.index !== frameIndex) selected.push(frames[frameIndex]);
    if (request + step === request) throw new Error('step is too small for this time range.');
  }
  await mkdir(path.join(output, 'frames'), { recursive: true });
  // Keep the expression tree shallow: FFmpeg rejects a long left-associated sum.
  const sum = terms => terms.length === 1 ? terms[0]
    : `(${sum(terms.slice(0, Math.ceil(terms.length / 2)))})+(${sum(terms.slice(Math.ceil(terms.length / 2)))})`;
  const select = sum(selected.map(frame => `eq(n\\,${frame.index})`));
  // Explicit display-aspect dimensions work on FFmpeg 6.1 as well as newer builds.
  // Merely dropping reset_sar would distort anamorphic sources; setsar alone
  // changes metadata, not geometry. Round only the final bounded dimensions.
  const thumbnailScale="scale=w='max(1,round(1280*min(dar,1)))':h='max(1,round(1280/max(dar,1)))',setsar=1";
  await executeMedia('ffmpeg', ['-v', 'error', '-n', '-copyts', '-i', source, '-map', '0:v:0', '-an',
    '-vf', `select=${select},${thumbnailScale}`,
    '-fps_mode', 'passthrough', '-q:v', '3', path.join(output, 'frames', 'frame_%05d.jpg')]);
  const frameFiles = await readdir(path.join(output, 'frames'));
  if (frameFiles.length !== selected.length) throw new Error('Extracted frame count does not match probed frames.');
  const hasAudio = metadata.streams.some(stream => stream.codec_type === 'audio');
  let originalAudio = null;
  let analysisAudio = null;
  if (!options.noAudio) {
    originalAudio = 'original.wav';
    analysisAudio = 'analysis.wav';
    const audioInput = hasAudio ? ['-copyts', '-i', source, '-map', '0:a:0']
      : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
    const align = hasAudio ? `asetpts=PTS-(${first})/TB,aresample=48000:async=1:first_pts=0,` : '';
    await executeMedia('ffmpeg', ['-v', 'error', '-n', ...audioInput, '-vn', '-af',
      `${align}apad=whole_len=${durationSamples},atrim=end_sample=${durationSamples}`,
      '-ar', String(sampleRate), '-ac', '2', '-c:a', 'pcm_f32le', path.join(output, originalAudio)]);
    await executeMedia('ffmpeg', ['-v', 'error', '-n', '-i', path.join(output, originalAudio),
      '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', path.join(output, analysisAudio)]);
  }
  await inspectLocalResearchExecution(context,'prepare_media_source_hash_io');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(source)) hash.update(chunk);
  await inspectLocalResearchExecution(context,'prepare_media_manifest_io');
  const manifest = {
    schema_version: 1,
    source_video: source,
    source_sha256: hash.digest('hex'),
    video: {
      first_pts_seconds: first, duration_seconds: duration,
      time_base: video.time_base, avg_frame_rate: video.avg_frame_rate,
    },
    timeline: { sample_rate: sampleRate, duration_samples: durationSamples },
    has_source_audio: hasAudio,
    original_audio: originalAudio,
    analysis_audio: analysisAudio,
    frames: selected.map((frame, index) => ({
      path: `frames/frame_${String(index + 1).padStart(5, '0')}.jpg`,
      source_pts_seconds: frame.pts, timeline_seconds: frame.pts - first,
    })),
  };
  if (options.window) manifest.analysis_window = { start_seconds: start, end_seconds: stop, step_seconds: step };
  await writeFile(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  await inspectLocalResearchExecution(context,'prepare_media_complete');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const manifest = await prepareEpisode(options);
    process.stdout.write(`Prepared ${manifest.frames.length} frames, ${manifest.timeline.duration_samples} samples.\n`);
  } catch (error) {
    process.stderr.write(`prepare_episode: ${error.message}\n`);
    process.exitCode = 1;
  }
}
