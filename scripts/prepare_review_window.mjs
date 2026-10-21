import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { hashFile } from './render_binding.mjs';

const execute = promisify(execFile);
// Internal continuous picture/sound evidence. This is never a replacement delivery video.
export async function prepareReviewWindow({ video, video_sha256, audio, audio_sha256,
  first_pts_seconds, source_range }, output) {
  if (!source_range?.every(Number.isFinite) || source_range.length !== 2 || source_range[0] < 0
    || source_range[1] <= source_range[0] || source_range[1] - source_range[0] > 30
    || !Number.isFinite(first_pts_seconds)) throw new Error('bounded_picture_review_window_required');
  if (await hashFile(video) !== video_sha256 || await hashFile(audio) !== audio_sha256) throw new Error('review_source_changed');
  // Some FFmpeg builds return exit 0 for -n when a file already exists.
  // Never report that old file as a newly prepared evidence window.
  try { await stat(output); throw new Error('review_output_already_exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(output), { recursive: true });
  const [start, end] = source_range;
  // FFmpeg 6.1 has no scale:reset_sar. Size from display aspect first,
  // then emit square pixels; even dimensions are required by H.264/yuv420p.
  const reviewScale="scale=w='max(2,2*floor(640*min(dar,1)/2))':h='max(2,2*floor(640/max(dar,1)/2))',setsar=1";
  await execute('ffmpeg', ['-v', 'error', '-nostdin', '-n', '-copyts', '-i', video, '-i', audio, '-filter_complex',
    `[0:v]trim=start=${first_pts_seconds + start}:end=${first_pts_seconds + end},setpts=PTS-STARTPTS,${reviewScale}[v];`
    + `[1:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a]`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'fast', '-crf', '25', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output],
  { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (await hashFile(video) !== video_sha256 || await hashFile(audio) !== audio_sha256) throw new Error('review_source_changed_during_encode');
  return { path: path.resolve(output), sha256: await hashFile(output), source_video_sha256: video_sha256,
    source_audio_sha256: audio_sha256, source_range, zero_point: 'start_of_review_window', encoded_for_analysis_only: true };
}
