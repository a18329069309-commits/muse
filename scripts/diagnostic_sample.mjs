import path from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashFile } from './render_binding.mjs';
import { saveJson } from './audio_api.mjs';
import { validateIndependentMusicPackPolicy } from './independent_music_policy.mjs';

// The assembly director selects the range. This step only exports that bound range.
export async function exportDiagnosticSample(config, record, out) {
  const selection = config.diagnostic_sample_selection;
  if (!selection || !record.preview) return record;
  await validateIndependentMusicPackPolicy(config, { outputDirectory: out, operation: 'render_research_trial' });
  const [start, end] = selection.target_range ?? [];
  const execute = promisify(execFile);
  const sourceProbe = await execute('ffprobe', ['-v', 'error', '-show_entries',
    'stream=sample_rate,duration_ts,time_base', '-of', 'json', path.join(record.audio_dir, 'bgm.wav')],
    { windowsHide: true });
  const sourceStream = JSON.parse(sourceProbe.stdout).streams[0];
  if (Number(sourceStream?.sample_rate) !== 48000 || sourceStream.time_base !== '1/48000'
    || !Number.isSafeInteger(sourceStream.duration_ts) || sourceStream.duration_ts <= 0)
    throw Error('diagnostic_sample_source_clock_invalid');
  const sourceDuration = sourceStream.duration_ts / 48000;
  if (selection.selected_by !== 'actual_episode_assembly_director' || !selection.reason?.trim()
    || !Number.isFinite(start) || !Number.isFinite(end) || start < 0
    || Math.round(end * 48000) > sourceStream.duration_ts
    || end - start < Math.min(20, sourceDuration) || end - start > 30)
    throw Error('diagnostic_sample_director_range_required');
  const directory = path.join(out, 'diagnostic-sample');
  await mkdir(directory, { recursive: true });
  const parent = { path: record.preview, sha256: await hashFile(record.preview) };
  const preview = path.join(directory, 'pending-review.mp4');
  await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-i', parent.path,
    '-t', String(end - start), '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast',
    '-crf', '23', '-maxrate', '1500k', '-bufsize', '3000k', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', preview], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if ((await stat(preview)).size > 30 * 1024 * 1024) throw Error('diagnostic_sample_preview_too_large');
  const first = Math.round(start * 48000), last = Math.round(end * 48000), stems = {};
  for (const name of ['bgm', 'sfx', 'ambience', 'accompaniment']) {
    const destination = path.join(directory, `${name}.wav`);
    await execute('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(record.audio_dir, `${name}.wav`),
      '-af', `atrim=start_sample=${first}:end_sample=${last},asetpts=PTS-STARTPTS`, '-ar', '48000',
      '-ac', '2', '-c:a', 'pcm_s24le', destination], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const probe = await execute('ffprobe', ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,bits_per_sample,duration_ts,time_base',
      '-of', 'json', destination], { windowsHide: true });
    const stream = JSON.parse(probe.stdout).streams[0];
    if (Number(stream.sample_rate) !== 48000 || stream.channels !== 2 || stream.bits_per_sample !== 24
      || stream.time_base !== '1/48000' || stream.duration_ts !== last - first)
      throw Error('diagnostic_sample_stem_format_or_length_invalid');
    stems[name] = { path: destination, sha256: await hashFile(destination), samples: last - first };
  }
  record.whole_episode_intermediate_preview = parent;
  record.preview = preview;
  record.diagnostic_sample = { ...selection, target_samples: last - first, source_sample_range: [first, last],
    preview: { path: preview, sha256: await hashFile(preview) }, stems,
    production_approval: false, full_episode_artistic_acceptance: false };
  record.diagnostic_sample_receipt = await saveJson(path.join(directory, 'sample.json'), record.diagnostic_sample);
  return record;
}
