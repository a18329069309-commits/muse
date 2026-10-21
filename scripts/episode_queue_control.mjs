import path from 'node:path';
import { access } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { EpisodeTaskQueue } from './episode_task_queue.mjs';
import { DatabaseSync } from 'node:sqlite';
import { discoverDiagnosticPreviewDeliveries } from './diagnostic_preview_delivery.mjs';

// This tool does not submit inference, reset budgets, discard history or approve unknown returns.
export async function inspectEpisodeQueue({ queue_file, retry_job, reason, reconcile_responses = false, include_deliveries = false }) {
  if (!path.isAbsolute(queue_file ?? '')) throw Error('existing_absolute_queue_path_required');
  await access(queue_file);
  // Pure status reads use SQLite read-only mode, including preview discovery.
  const mutable = Boolean(retry_job || reconcile_responses);
  const db = mutable ? null : new DatabaseSync(queue_file, { readOnly: true });
  const queue = mutable ? new EpisodeTaskQueue(queue_file) : {
    list: () => db.prepare('SELECT * FROM episode_jobs ORDER BY created_at,episode_id').all(),
    stages: id => db.prepare('SELECT * FROM episode_stages WHERE job_id=? ORDER BY stage').all(id),
    executorState: () => db.prepare("SELECT status FROM queue_executor WHERE name='model'").get().status,
    close: () => db.close(),
  };
  try {
    if (reconcile_responses) await queue.reconcilePendingResponses();
    if (retry_job) queue.retry(retry_job, { reason });
    const rows = queue.list();
    const jobs = rows.map(row => ({ job_id: row.job_id, episode_id: row.episode_id,
      source_sha256: row.source_sha, status: row.status, attempts: row.attempts,
      output_dir: row.output_dir, error: row.error,
      stages: queue.stages(row.job_id).map(stage => ({ stage: stage.stage, status: stage.status,
        updated_at: stage.updated_at })) }));
    if (include_deliveries) for (const [index, row] of rows.entries()) {
      const result = row.result_json ? JSON.parse(row.result_json) : {};
      jobs[index].diagnostic_deliveries = await discoverDiagnosticPreviewDeliveries({
        episodeDirectory: row.output_dir, sourceSha: row.source_sha,
        renderBindings: (result.render_registry ?? []).flatMap(item => item.files ?? []) });
    }
    return { queue_file, executor_state: queue.executorState(), jobs,
      inference_calls: 0, budgets_reset: false, entire_corpus_complete: false };
  } finally { queue.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { queue: { type: 'string' }, retry: { type: 'string' },
      reason: { type: 'string' }, 'reconcile-responses': { type: 'boolean', default: false },
      'include-deliveries': { type: 'boolean', default: false } } });
    console.log(JSON.stringify(await inspectEpisodeQueue({ queue_file: values.queue,
      retry_job: values.retry, reason: values.reason, reconcile_responses: values['reconcile-responses'],
      include_deliveries: values['include-deliveries'] }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
