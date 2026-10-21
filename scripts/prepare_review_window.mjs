import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
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
  await mkdir(path.dirname(output), { recursive: true });
  const [start, end] = source_range;
  await execute('ffmpeg', ['-v', 'error', '-n', '-copyts', '-i', video, '-i', audio, '-filter_complex',
    `[0:v]trim=start=${first_pts_seconds + start}:end=${first_pts_seconds + end},setpts=PTS-STARTPTS,scale=640:640:force_original_aspect_ratio=decrease:reset_sar=1[v];`
    + `[1:a]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS[a]`, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', output],
  { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (await hashFile(video) !== video_sha256 || await hashFile(audio) !== audio_sha256) throw new Error('review_source_changed_during_encode');
  return { path: path.resolve(output), sha256: await hashFile(output), source_video_sha256: video_sha256,
    source_audio_sha256: audio_sha256, source_range, zero_point: 'start_of_review_window', encoded_for_analysis_only: true };
}
