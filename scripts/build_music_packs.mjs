import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readJson, saveJson } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const run = promisify(execFile), here = path.dirname(fileURLToPath(import.meta.url));

/** Build an immutable diagnostic library from actual recordings.
 * Editorial presets, publisher metadata and technical observations never grant
 * listening, lyric, phrase-boundary or production approval.
 */
export async function buildMusicPacks(config, runtime = {}) {
  if (!config || !path.isAbsolute(config.output_dir ?? '')) throw Error('music_packs_absolute_output_required');
  if (config.mode !== 'research' || config.trial_review_policy !== 'diagnostic_candidates')
    throw Error('music_packs_explicit_diagnostic_research_required');
  if (!config.source_catalogues?.length && !config.local_folders?.length && !config.acquisition_inputs?.length)
    throw Error('music_packs_actual_recordings_required');
  await mkdir(config.output_dir, { recursive: true });
  const prepared = structuredClone(config);
  if (runtime.acquire) {
    const acquired = await runtime.acquire(config.acquisition_inputs ?? [], config);
    if (!acquired?.catalogue || !path.isAbsolute(acquired.catalogue.path ?? ''))
      throw Error('music_packs_acquisition_binding_required');
    if (await hashFile(acquired.catalogue.path) !== acquired.catalogue.sha256)
      throw Error('music_packs_acquisition_changed');
    prepared.source_catalogues = [...(prepared.source_catalogues ?? []), acquired.catalogue];
    prepared.acquisition_inputs = [];
  }
  // Each invocation keeps its receipt; immutable freeze identity is determined
  // by actual input hashes inside the builder, not by a mutable latest file.
  const runDirectory = path.join(config.output_dir, 'runs', randomUUID());
  await mkdir(runDirectory, { recursive: true });
  const configBinding = await saveJson(path.join(runDirectory, 'build-request.json'), prepared);
  const resultFile = path.join(runDirectory, 'build-result.json');
  await run(config.python ?? 'python', ['-X', 'utf8', path.join(here, 'independent_music_pack_library.py'),
    'build', '--input', configBinding.path, '--output', resultFile],
  { windowsHide: true, maxBuffer: 4 * 1024 * 1024, timeout: config.timeout_ms ?? 15 * 60 * 1000 });
  const result = await readJson(resultFile);
  if (!result.publication || await hashFile(result.publication.path) !== result.publication.sha256)
    throw Error('music_packs_frozen_publication_changed');
  result.execution_receipt = { path: resultFile, sha256: await hashFile(resultFile) };
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--config');
  if (at < 0) throw Error('Usage: node build_music_packs.mjs --config absolute-config.json');
  const result = await buildMusicPacks(await readJson(process.argv[at + 1]));
  console.log(JSON.stringify(result, null, 2));
}
