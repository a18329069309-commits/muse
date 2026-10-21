import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveJson, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const run = promisify(execFile);
const helper = fileURLToPath(new URL('./actual_pcm_source_clock.py', import.meta.url));
const processor = fileURLToPath(new URL('./independent_recording_checks.py', import.meta.url));
export const actualPcmSourceClockRevision = 'actual-pcm-source-clock-v1';

// Container duration is deliberately not a fallback for a decoded PCM clock.
export async function readActualPcmSourceClock(source, options = {}) {
  if (!path.isAbsolute(source?.path ?? '') || !/^[a-f0-9]{64}$/.test(source?.sha256 ?? ''))
    throw Error('actual_pcm_clock_source_binding_required');
  await verifyEvidenceBindings(source);
  const publication = options.publication_binding;
  if (publication) await verifyEvidenceBindings(publication);
  const implementations = { helper: await hashFile(helper), processor: await hashFile(processor) };
  const cache = options.cache_directory ?? path.join(tmpdir(), 'short-drama-actual-pcm-clock-cache');
  const python=options.python??process.env.SDR_PYTHON??'python';
  const args = ['-X', 'utf8', helper, '--source', source.path, '--sha256', source.sha256,
    '--cache-dir', path.resolve(cache), ...(publication ? ['--publication', publication.path,
      '--publication-sha256', publication.sha256] : [])];
  const started = new Date().toISOString();
  const result = await run(python, args, {
    windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 600000 });
  const clock = JSON.parse(result.stdout);
  if (clock.revision !== actualPcmSourceClockRevision || clock.source?.sha256 !== source.sha256
    || path.resolve(clock.source.path) !== path.resolve(source.path)
    || clock.helper_sha256 !== implementations.helper || clock.processor_sha256 !== implementations.processor
    || clock.clock_basis !== 'actual_decoded_pcm_samples' || clock.sample_rate_hz !== 48000
    || !Number.isSafeInteger(clock.decoded_samples) || clock.decoded_samples <= 0
    || clock.full_decode?.exit_code !== 0 || clock.full_decode?.strict_errors !== true
    || clock.full_decode?.decoded_samples !== clock.decoded_samples
    || clock.full_decode?.decoded_sample_rate_hz !== 48000
    || clock.qualification_granted !== false || clock.production_approval !== false)
    throw Error('actual_pcm_clock_execution_evidence_invalid');
  await verifyEvidenceBindings(source);
  if (publication) await verifyEvidenceBindings(publication);
  if (await hashFile(helper) !== implementations.helper || await hashFile(processor) !== implementations.processor)
    throw Error('actual_pcm_clock_processor_changed');
  const receipt = { ...clock, execution: { python, arguments: args,
    started_at: started, completed_at: new Date().toISOString(), exit_code: 0,
    actual_model_calls: 0, paid_calls: 0 }, implementations };
  if (options.output_directory) receipt.receipt_binding = await saveJson(
    path.join(options.output_directory, source.sha256 + '.json'), receipt);
  return receipt;
}
