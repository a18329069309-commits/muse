// Only fixed, self-generated synthetic media enter this helper. This is not a
// story analyser, material selector, provider adapter, or publication gate.
import './no-network.mjs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, realpath, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RATE = 48000, SECONDS = 3, FRAMES = RATE * SECONDS;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const safeErrors = new Set(['EEXIST', 'ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ENOSPC', 'EROFS', 'ELOOP',
  'demo_episode_failed', 'demo_child_timeout', 'demo_child_output_limit', 'demo_child_could_not_start',
  'demo_output_path_invalid_or_C_drive', 'demo_output_root_forbidden', 'demo_episode_invalid',
  'demo_nonfinite_decoded_sample', 'demo_invalid_decode', 'demo_renderer_not_technical_ok',
  'demo_audio_duration_silence_or_peak_check_failed', 'demo_cut_frame_decode_failed',
  'demo_composition_ducking_or_cut_check_failed', 'demo_preview_probe_failed',
  'demo_preview_evidence_invalid',
  'demo_worker_report_invalid', 'demo_episode_not_technical_ok', 'demo_episodes_must_be_1_or_2',
  'demo_runner_must_be_function', 'demo_duplicate_option', 'demo_output_argument_required', 'demo_unknown_option']);

export function demoErrorCode(error) {
  const value = error?.code ?? error?.message;
  return safeErrors.has(value) || (typeof value === 'string'
    && /^demo_child_failed_exit_(?:null|[0-9]{1,3})$/.test(value)) ? value : 'demo_episode_failed';
}

export function cleanDemoEnvironment(temporaryDirectory, inheritedEnvironment = process.env) {
  const environment = { ...inheritedEnvironment, TMP: temporaryDirectory, TEMP: temporaryDirectory,
    TMPDIR: temporaryDirectory, PYTHONDONTWRITEBYTECODE: '1' };
  for (const key of Object.keys(environment)) {
    if (/^(?:FFREPORT|REPORT|NODE_OPTIONS|AV_LOG_FORCE_COLOR)$/i.test(key)
      || /^(?:SDR_|OPENAI_|ANTHROPIC_|GEMINI_)/i.test(key)
      || /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PASSWORD)$/i.test(key)) delete environment[key];
  }
  return environment;
}

export function runBounded(command, args, { cwd, env, timeout = 20000, limit = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, failure;
    const abort = message => { failure ??= new Error(message); child.kill(); };
    const timer = setTimeout(() => abort('demo_child_timeout'), timeout);
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > limit) abort('demo_child_output_limit');
        else chunks.push(chunk);
      });
    }
    child.on('error', () => { failure ??= new Error('demo_child_could_not_start'); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`demo_child_failed_exit_${code}`));
      else resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

// Never create the parent, follow an unexamined junction, or reuse a leaf.
export async function resolveNewOutput(value) {
  if (typeof value !== 'string' || !value.trim() || /^[cC]:/.test(value)
    || (/^[a-zA-Z]:/.test(value) && !/^[a-zA-Z]:[\\/]/.test(value))) {
    throw new Error('demo_output_path_invalid_or_C_drive');
  }
  const proposed = path.resolve(value), parent = await realpath(path.dirname(proposed));
  const target = path.join(parent, path.basename(proposed));
  if (/^[cC]:/.test(target) || target === path.parse(target).root
    || target.toLowerCase() === PROJECT_ROOT.toLowerCase()) throw new Error('demo_output_root_forbidden');
  return target;
}

async function writePcm(file, at) {
  const bytes = Buffer.alloc(44 + FRAMES * 4);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 4, 28);
  bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(FRAMES * 4, 40);
  for (let frame = 0; frame < FRAMES; frame++) {
    const sample = Math.round(at(frame / RATE, frame) * 32767);
    bytes.writeInt16LE(sample, 44 + frame * 4); bytes.writeInt16LE(sample, 46 + frame * 4);
  }
  await writeFile(file, bytes, { flag: 'wx' });
}

function statistics(data) {
  let peak = 0, energy = 0;
  for (const value of data) {
    if (!Number.isFinite(value)) throw new Error('demo_nonfinite_decoded_sample');
    peak = Math.max(peak, Math.abs(value)); energy += value * value;
  }
  return { duration_samples: data.length / 2, duration_seconds: data.length / 2 / RATE,
    sample_peak_linear: peak, rms_linear: Math.sqrt(energy / data.length), non_silent: peak > 0.0001 };
}

// Pure validation seam for technical edge cases; NaN must never turn a failed
// comparison into a successful technical report.
export function validatePreviewEvidence({ sampleCount, previewEnergy, targetEnergy, product, durationSeconds }) {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < FRAMES || sampleCount > FRAMES + 1024
    || ![previewEnergy, targetEnergy, product, durationSeconds].every(Number.isFinite)
    || previewEnergy <= 0 || targetEnergy <= 0 || durationSeconds <= 0
    || Math.abs(durationSeconds - SECONDS) > 0.05) throw new Error('demo_preview_evidence_invalid');
  const correlation = product / Math.sqrt(previewEnergy * targetEnergy);
  if (!Number.isFinite(correlation) || correlation < 0.98 || correlation > 1.00001)
    throw new Error('demo_preview_evidence_invalid');
  return correlation;
}

export async function executeSyntheticEpisode({ directory, index }) {
  if (![1, 2].includes(index)) throw new Error('demo_episode_invalid');
  const output = await resolveNewOutput(directory);
  await mkdir(output); // exclusive ownership: existing files and empty directories are both refused
  const environment = cleanDemoEnvironment(output);
  const ffmpeg = args => runBounded('ffmpeg', ['-hide_banner', '-nostdin', '-v', 'error', '-n', ...args],
    { cwd: output, env: environment });
  const decode = async file => {
    const { stdout } = await ffmpeg(['-i', file, '-map', '0:a:0', '-ar', String(RATE),
      '-ac', '2', '-f', 'f32le', 'pipe:1']);
    if (!stdout.length || stdout.length % 8) throw new Error('demo_invalid_decode');
    return new Float32Array(stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length));
  };
  const tone = (frequency, t) => Math.sin(2 * Math.PI * frequency * t);
  const proxy = t => ((t >= 0.6 && t < 1.4) || (t >= 2 && t < 2.5))
    ? 0.15 * tone(740 + index * 20, t) + 0.05 * tone(1080, t) : 0;
  await writePcm(path.join(output, 'original.wav'), proxy);
  await writePcm(path.join(output, 'tone-bed.wav'), t => 0.09 * tone(220 + index * 30, t));
  await writePcm(path.join(output, 'tone-ambience.wav'), t => 0.025 * tone(70, t));
  // A short decaying synthetic transient, deliberately positioned at the fixed cut at 1.5 seconds.
  await writePcm(path.join(output, 'tone-effect.wav'), t => t < 0.15
    ? 0.18 * Math.exp(-35 * t) * tone(1600, t) : 0);
  const visual = `color=c=${index === 1 ? '0x244e7c' : '0x49704b'}:s=320x180:r=24:d=3,`
    + "drawbox=x=0:y=0:w=iw:h=ih:color=0xdbe7ed:t=fill:enable='gte(t,1.5)'";
  await ffmpeg(['-f', 'lavfi', '-i', visual,
    '-i', 'original.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p', '-c:a', 'alac', '-t', '3', 'source.mp4']);
  const sourceHash = hash(await readFile(path.join(output, 'source.mp4')));
  await writeFile(path.join(output, 'manifest.json'), json({ schema_version: 1,
    source_video: 'source.mp4', source_sha256: sourceHash, original_audio: 'original.wav',
    has_source_audio: true, timeline: { sample_rate: RATE, duration_samples: FRAMES },
    fixture_kind: 'synthetic_tonal_dialogue_proxy_not_human_speech' }), { flag: 'wx' });
  const cue = (id, track, asset, start, length, gain = 0) => ({ id, track, asset_id: asset,
    source_in_seconds: 0, source_out_seconds: length, start_seconds: start, gain_db: gain,
    fade_in_seconds: track === 'sfx' ? 0 : 0.08, fade_out_seconds: 0.08, fade_curve: 'raised_cosine' });
  const plan = { schema_version: 1, manifest: 'manifest.json', audience: 'auto', mode: 'materials',
    execution: 'local', original_audio_kind: 'dialogue_only', dialogue_ducking_db: 10,
    dialogue_intervals: [{ start_seconds: 0.6, end_seconds: 1.4 }, { start_seconds: 2, end_seconds: 2.5 }],
    assets: [{ id: 'bed', path: 'tone-bed.wav' }, { id: 'effect', path: 'tone-effect.wav' },
      { id: 'room', path: 'tone-ambience.wav' }],
    cues: [cue('bed-01', 'bgm', 'bed', 0, SECONDS), cue('cut-01', 'sfx', 'effect', 1.5, 0.3),
      cue('room-01', 'ambience', 'room', 0, SECONDS)] };
  await writeFile(path.join(output, 'plan.json'), json(plan), { flag: 'wx' });
  // Import only after the worker was started with its cleaned environment and the network shim.
  const { renderPlan } = await import('../scripts/render_audio.mjs');
  const rendered = await renderPlan(path.join(output, 'plan.json'), path.join(output, 'render'), { cwd: output });
  if (rendered.status !== 'technical_ok') throw new Error('demo_renderer_not_technical_ok');
  await ffmpeg(['-i', 'original.wav', '-i', 'render/accompaniment.wav', '-filter_complex',
    '[0:a][1:a]amix=inputs=2:normalize=0:duration=first:dropout_transition=0[a]', '-map', '[a]',
    '-c:a', 'pcm_s24le', 'final-mix.wav']);
  await ffmpeg(['-i', 'source.mp4', '-i', 'final-mix.wav', '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', '3', '-movflags', '+faststart', 'preview.mp4']);
  const names = ['bgm', 'sfx', 'ambience', 'accompaniment'];
  const decoded = Object.fromEntries(await Promise.all(names.map(async name =>
    [name, await decode(`render/${name}.wav`)])));
  decoded.original = await decode('original.wav'); decoded.final_mix = await decode('final-mix.wav');
  decoded.preview = await decode('preview.mp4'); decoded.source = await decode('source.mp4');
  const measurements = Object.fromEntries(Object.entries(decoded).map(([name, data]) => [name, statistics(data)]));
  if (Object.entries(measurements).some(([name, row]) => !row.non_silent
    || (name === 'preview' ? row.duration_samples < FRAMES || row.duration_samples > FRAMES + 1024
      : row.duration_samples !== FRAMES)
    || row.sample_peak_linear >= 1)) throw new Error('demo_audio_duration_silence_or_peak_check_failed');
  let compositionError = 0, sourceError = 0, previewEnergy = 0, targetEnergy = 0, product = 0;
  for (let i = 0; i < FRAMES * 2; i++) {
    compositionError = Math.max(compositionError,
      Math.abs(decoded.final_mix[i] - decoded.accompaniment[i] - decoded.original[i]));
    sourceError = Math.max(sourceError, Math.abs(decoded.source[i] - decoded.original[i]));
    previewEnergy += decoded.preview[i] ** 2; targetEnergy += decoded.final_mix[i] ** 2;
    product += decoded.preview[i] * decoded.final_mix[i];
  }
  const frameAt = async time => (await ffmpeg(['-ss', String(time), '-i', 'source.mp4',
    '-map', '0:v:0', '-frames:v', '1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])).stdout;
  const beforeCut = await frameAt(35 / 24), afterCut = await frameAt(1.5);
  if (beforeCut.length !== 320 * 180 * 3 || afterCut.length !== beforeCut.length)
    throw new Error('demo_cut_frame_decode_failed');
  let cutDifference = 0;
  for (let i = 0; i < beforeCut.length; i++) cutDifference += Math.abs(beforeCut[i] - afterCut[i]);
  cutDifference /= beforeCut.length;
  const rmsBetween = (data, start, end) => statistics(data.subarray(start * RATE * 2, end * RATE * 2)).rms_linear;
  const duckingDb = 20 * Math.log10(rmsBetween(decoded.bgm, 0.8, 1.2) / rmsBetween(decoded.bgm, 0.2, 0.4));
  const firstEffectSample = decoded.sfx.findIndex(value => Math.abs(value) > 0.0001) / 2;
  if (compositionError > 2 / 8388608 || sourceError > 1 / 32768
    || cutDifference < 20 || Math.abs(duckingDb + 10) > 0.1 || firstEffectSample < 1.5 * RATE
    || firstEffectSample > 1.5 * RATE + 4) throw new Error('demo_composition_ducking_or_cut_check_failed');
  const probe = JSON.parse((await runBounded('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,duration:format=duration', '-of', 'json', 'preview.mp4'],
    { cwd: output, env: environment })).stdout.toString());
  if (!probe.streams?.some(row => row.codec_type === 'video' && row.codec_name === 'h264')
    || !probe.streams?.some(row => row.codec_type === 'audio' && row.codec_name === 'aac'))
    throw new Error('demo_preview_probe_failed');
  const previewCorrelation = validatePreviewEvidence({ sampleCount: measurements.preview.duration_samples,
    previewEnergy, targetEnergy, product, durationSeconds: Number(probe.format?.duration) });
  const artifacts = {};
  for (const relative of ['source.mp4', 'original.wav', 'tone-bed.wav', 'tone-effect.wav', 'tone-ambience.wav',
    'manifest.json', 'plan.json', 'render/report.json', ...names.map(name => `render/${name}.wav`),
    'final-mix.wav', 'preview.mp4']) {
    const bytes = await readFile(path.join(output, relative));
    artifacts[relative] = { sha256: hash(bytes), bytes: bytes.length };
  }
  const report = { schema_version: 1, status: 'technical_ok', episode: index,
    kind: 'synthetic_fixed_plan_rendering_demo', duration_seconds: SECONDS, sample_rate: RATE,
    creative_review: 'not_performed', audible_sync_review: 'not_performed', production_approval: false,
    fixtures: 'self-generated PCM tones and FFmpeg lavfi color; dialogue is a tonal proxy, not speech',
    measurements, checks: { stems_non_silent_and_sample_aligned: true,
      original_plus_accompaniment_once_max_error: compositionError,
      source_original_max_error: sourceError, preview_final_mix_correlation: previewCorrelation,
      dialogue_proxy_ducking_db: duckingDb, fixed_cut_seconds: 1.5, first_sfx_sample: firstEffectSample,
      video_cut: { fps: 24, before_seconds: 35 / 24, after_seconds: 1.5,
        decoded_rgb_mean_absolute_difference: cutDifference, before_sha256: hash(beforeCut),
        after_sha256: hash(afterCut) } },
    preview: 'preview.mp4', artifacts,
    scope: 'renderPlan technical rendering only; not automatic analysis, selection, composeUploadedEpisode, composeBatch, hearing review, or consumer publication acceptance' };
  await writeFile(path.join(output, 'episode-report.json'), json(report), { flag: 'wx' });
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [number, directory, ...extra] = process.argv.slice(2);
  if (!directory || extra.length || !['1', '2'].includes(number)) {
    console.error('Internal fixed-fixture helper requires episode 1 or 2 and a fresh output leaf');
    process.exitCode = 1;
  } else {
    executeSyntheticEpisode({ directory, index: Number(number) })
      .then(report => console.log(JSON.stringify({ status: report.status, episode: report.episode })))
      .catch(error => { console.error(demoErrorCode(error)); process.exitCode = 1; });
  }
}
