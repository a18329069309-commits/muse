import path from 'node:path';
import { HostFileSession } from './host_runtime.mjs';
import { readJson, saveJson, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

// A real executor, rather than an unattended request file. CLI inference still grants no audio or artistic qualification.
export class CodexHostSession extends HostFileSession {
  constructor({ directory, runtime, media = [], observer = null, observerLedger = null, audioBackend = null }) {
    if (typeof runtime?.request !== 'function' || runtime.director_backend_id !== 'codex-cli-chatgpt'
      || !runtime.director_model_revision) throw new Error('actual_codex_cli_runtime_required');
    super({ directory, backend: { protocol: 'codex_host_file', backend_id: 'codex-host',
      model_revision: runtime.director_model_revision.split(':')[0] }, media, observer, observerLedger, audioBackend });
    this.runtime = runtime; this.backend_kind = 'codex_cli';
    this.backend = { protocol: 'codex_cli', backend_id: runtime.director_backend_id, model_revision: runtime.director_model_revision };
  }
  get accountingLedger() {
    if (!Array.isArray(this.runtime.ledger)) return this.ledger;
    // Executor receipts include failed attempts; successful host consumption must not count them again.
    return [...this.ledger.filter(row => row.execution_kind !== 'codex_cli_host_consumption'),
      ...this.runtime.ledger.map(row => {
        const known = Number.isInteger(row.cli_invocations) && row.cli_invocations >= 0;
        return { stage: row.stage, request_sha256: row.request_sha256, execution_kind: 'codex_cli_attempt',
          model_calls: known ? row.cli_invocations : null, cloud_uploads: known ? row.cli_invocations : null,
          accounting: known ? 'existing_chatgpt_account_usage' : 'not_reported', cost_ceiling_usd: null,
          status: row.status, usage: row.usage, receipt: row.receipt };
      })];
  }
  async request(role, input) {
    const deadlineBudget = this.runtime.trialBudget?.identity?.wall_clock_policy ? this.runtime.trialBudget : null;
    await deadlineBudget?.inspectLocal({ stage: 'codex_host_request_io' });
    const response = await this.runtime.request(role, input);
    const expectedRevision=this.runtime.expectedStageModelRevision?.(input.stage) ?? this.backend.model_revision;
    const storyEvidenceMerge = response.execution_kind === 'deterministic_story_part_evidence_merge_of_actual_patch';
    if (storyEvidenceMerge) {
      if (role !== 'director' || !/^research_story_director_part_\d+$/.test(input.stage ?? ''))
        throw Error('codex_host_story_part_merge_stage_required');
      const { loadStoryPartEvidenceRecovery } = await import('./story_part_evidence_repair.mjs');
      await loadStoryPartEvidenceRecovery(response.raw_response, { input, expectedModelRevision: expectedRevision });
    }
    if (response.backend_id !== this.backend.backend_id || response.model_revision !== expectedRevision
      || !storyEvidenceMerge && response.execution_kind !== 'codex_cli_inference' || response.actual_runtime_executed !== true
      || response.actual_input_processed !== true || response.actual_audio_processed !== false
      || response.actual_video_processed !== false || response.completion_status !== 'complete'
      || response.qualified !== false || response.artistic_approval !== false || response.production_approval !== false
      || !Array.isArray(response.scopes) || response.scopes.length || !/^[a-f0-9]{64}$/.test(response.request_sha256 ?? '')
      || !response.raw_response?.sha256)
      throw new Error('real_codex_cli_response_required');
    await verifyEvidenceBindings(response.raw_response);
    const raw = await readJson(response.raw_response.path);
    if (JSON.stringify(raw.value) !== JSON.stringify(response.value)
      || raw.source_video_sha256 !== (input.data?.source_video_sha256 ?? input.source_video_sha256 ?? null)
      || raw.model_revision !== expectedRevision || raw.execution_kind !== response.execution_kind
      || ['actual_runtime_executed', 'actual_input_processed', 'actual_audio_processed', 'actual_video_processed',
        'completion_status', 'qualified', 'artistic_approval', 'production_approval', 'request_sha256']
        .some(key => raw[key] !== response[key]) || !Array.isArray(raw.evidence_files)
      || raw.source_video_sha256 && !raw.evidence_files.some(item => item.sha256 === raw.source_video_sha256))
      throw new Error('codex_host_response_binding_mismatch');
    await verifyEvidenceBindings(raw.evidence_files);
    validateSchema(response.value, input.schema ?? input.response_schema);
    const receipt = await saveJson(path.join(this.directory, response.request_sha256, 'host-consumption.json'), {
      schema_version: 1, stage: role, execution_kind: 'codex_cli_host_consumption', response: response.raw_response,
      backend: {...this.backend,model_revision:expectedRevision}, reused: response.reused === true, usage: response.usage,
      cli_receipts: response.cli_receipts ?? [], historical_cli_receipts: response.historical_cli_receipts ?? [],
      actual_audio_processed: false, formal_adoption_allowed: false, production_approval: false,
    }).catch(async error => {
      if (error.code !== 'EEXIST') throw error;
      const file = path.join(this.directory, response.request_sha256, 'host-consumption.json');
      const existing = await readJson(file);
      if (existing.response.sha256 !== response.raw_response.sha256) throw new Error('codex_host_consumption_changed');
      return { path: file, sha256: await hashFile(file) };
    });
    if (!this.ledger.some(row => row.request_sha256 === response.request_sha256)) this.ledger.push({
      stage: role, request_sha256: response.request_sha256, execution_kind: 'codex_cli_host_consumption',
      model_calls: response.cli_receipts?.length ?? 0, cloud_uploads: response.cli_receipts?.length ?? 0,
      cost_ceiling_usd: null, accounting: 'existing_chatgpt_account_usage', reused: response.reused === true,
      usage: response.usage, receipt,
    });
    await deadlineBudget?.inspectLocal({ stage: 'codex_host_consumption_io_complete' });
    return response;
  }
}

export const createCodexHostSession = options => new CodexHostSession(options);
