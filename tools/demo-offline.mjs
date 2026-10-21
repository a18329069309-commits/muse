import './no-network.mjs';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { cleanDemoEnvironment, demoErrorCode, PROJECT_ROOT, resolveNewOutput, runBounded } from './demo-engine.mjs';

export const HELP = `Usage: node tools/demo-offline.mjs [--out NEW_DIRECTORY] [--episodes 1|2] [--help]

Runs one or two fixed 3-second synthetic episodes in order (default: 2).
Default output is a fresh .muse/demo-* directory in this project.
--out requires an existing parent and a NEW leaf; no existing directory is reused.
C drive and filesystem/workspace roots are refused. Nothing is downloaded.

This exercises the real renderPlan renderer, not automatic story analysis,
music selection, composeUploadedEpisode/composeBatch, or artistic approval.
FFmpeg/FFprobe are required. All tones and color frames are generated locally.
Node networking is denied and sensitive provider environment variables are removed
from children; this is NOT an operating-system network sandbox.
Reports and failed outputs are preserved; there is no recursive cleanup.
`;

export function parseDemoArgs(args) {
  const options = { episodes: 2 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error('demo_duplicate_option');
    seen.add(flag);
    if (flag === '--help') options.help = true;
    else if (flag === '--out') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('demo_output_argument_required');
      options.out = args[++i];
    } else if (flag === '--episodes') {
      if (!['1', '2'].includes(args[i + 1])) throw new Error('demo_episodes_must_be_1_or_2');
      options.episodes = Number(args[++i]);
    } else throw new Error('demo_unknown_option');
  }
  return options;
}

export async function runEpisodeWorker({ directory, index }) {
  await runBounded(process.execPath, ['--import', pathToFileURL(path.join(PROJECT_ROOT, 'tools/no-network.mjs')).href,
    path.join(PROJECT_ROOT, 'tools/demo-engine.mjs'), String(index), directory],
  { cwd: path.dirname(directory), env: cleanDemoEnvironment(path.dirname(directory)), timeout: 60000,
    limit: 1024 * 1024 });
  const report = JSON.parse(await readFile(path.join(directory, 'episode-report.json'), 'utf8'));
  if (report.status !== 'technical_ok' || report.episode !== index) throw new Error('demo_worker_report_invalid');
  return report;
}

// Public embedding seam: callers may supply a runner, e.g. a host job scheduler.
// Directory reservation and per-episode error isolation remain owned here.
export async function runOfflineDemo({ out, episodes = 2 } = {}, { runEpisode = runEpisodeWorker } = {}) {
  if (![1, 2].includes(episodes)) throw new Error('demo_episodes_must_be_1_or_2');
  if (typeof runEpisode !== 'function') throw new Error('demo_runner_must_be_function');
  let output;
  if (out !== undefined) {
    output = await resolveNewOutput(out);
    await mkdir(output); // mkdir is intentionally non-recursive and exclusive
  } else {
    const resolvedRoot = await realpath(PROJECT_ROOT);
    if (/^[cC]:/.test(resolvedRoot)) throw new Error('demo_output_root_forbidden');
    const state = path.join(PROJECT_ROOT, '.muse');
    try {
      await lstat(state);
      if (/^[cC]:/.test(await realpath(state))) throw new Error('demo_output_root_forbidden');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await mkdir(state); // known D/non-C parent, exclusive leaf; never follow a broken junction
    }
    const resolvedState = await realpath(state);
    await resolveNewOutput(path.join(resolvedState, 'demo-safety-check'));
    output = await mkdtemp(path.join(resolvedState, 'demo-'));
  }
  const report = { schema_version: 1, kind: 'synthetic_fixed_plan_rendering_demo',
    status: 'running', execution: 'sequential_with_per_episode_failure_isolation',
    requested_episodes: episodes, episodes: [],
    network_controls: 'Node no-network shim and cleaned child environment; not an OS network sandbox',
    downloads: 'none', input_media: 'self-generated synthetic fixtures only',
    creative_review: 'not_performed', audible_sync_review: 'not_performed', production_approval: false,
    scope: 'renderPlan fixed-plan rendering; not automatic plot analysis, selection, composeUploadedEpisode/composeBatch, or production acceptance' };
  const save = () => writeFile(path.join(output, 'demo-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await save();
  for (let index = 1; index <= episodes; index++) {
    const name = `episode-${String(index).padStart(2, '0')}`;
    try {
      const episode = await runEpisode({ index, directory: path.join(output, name) });
      if (episode?.status !== 'technical_ok') throw new Error('demo_episode_not_technical_ok');
      report.episodes.push({ episode: index, status: 'technical_ok',
        report: `${name}/episode-report.json`, preview: `${name}/preview.mp4` });
    } catch (error) {
      report.episodes.push({ episode: index, status: 'failed',
        error: demoErrorCode(error), directory: name });
    }
    await save();
  }
  report.status = report.episodes.every(row => row.status === 'technical_ok') ? 'technical_ok' : 'failed';
  await save();
  return { outputDirectory: output, report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseDemoArgs(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const result = await runOfflineDemo(options);
      console.log(JSON.stringify({ status: result.report.status, output: result.outputDirectory,
        report: 'demo-report.json', episodes: result.report.episodes }, null, 2));
      if (result.report.status !== 'technical_ok') process.exitCode = 1;
    }
  } catch (error) {
    console.error(demoErrorCode(error)); process.exitCode = 1;
  }
}
