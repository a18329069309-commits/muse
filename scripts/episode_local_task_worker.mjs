import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (request.schema_version !== 1 || !Array.isArray(request.args) || !path.isAbsolute(request.result ?? '')
  || !Number.isSafeInteger(request.deadline_at_ms) || request.deadline_at_ms <= Date.now())
  throw Error('owned_episode_task_request_invalid_or_expired');
process.env.SDR_EPISODE_DEADLINE_AT_MS = String(request.deadline_at_ms);
let value;
if (request.operation === 'render_research_trial') {
  const { renderResearchTrial } = await import('./render_research_trial.mjs');
  value = await renderResearchTrial(...request.args);
} else if (request.operation === 'run_sound_job') {
  const { runSoundJob } = await import('./run_sound_job.mjs');
  value = await runSoundJob(...request.args);
} else throw Error('owned_episode_task_operation_invalid');
if (Date.now() >= request.deadline_at_ms) throw Error('owned_episode_task_result_deadline_exhausted');
await writeFile(request.result, JSON.stringify(value) + '\n', { flag: 'wx' });
