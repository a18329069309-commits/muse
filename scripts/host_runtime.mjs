import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, saveJson, shaBytes, validateSchema, verifyEvidenceBindings, audioBackendMatches } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const bound = async file => ({ path: path.resolve(file), sha256: await hashFile(file) });
const same = (a, b) => canonical(a) === canonical(b);

export function resolveHostBackend(value) {
  if (value?.protocol !== 'codex_host_file' || value.backend_id !== 'codex-host') throw new Error('unsupported_host_backend');
  if (typeof value.model_revision !== 'string' || !(value.model_revision === 'codex-host-model-not-exposed'
    || /^gpt-[a-zA-Z0-9._-]+$/.test(value.model_revision)))
    throw new Error('explicit_host_model_identity_required');
  return { protocol: value.protocol, backend_id: value.backend_id, model_revision: value.model_revision };
}

async function collectBindings(value, rows = new Map()) {
  if (!value || typeof value !== 'object') return rows;
  if (typeof value.path === 'string' && (value.sha256 || value.source_sha256)) {
    const item = { path: path.resolve(value.path), sha256: value.sha256 ?? value.source_sha256 };
    if (rows.has(item.path) && rows.get(item.path).sha256 !== item.sha256) throw new Error('host_input_binding_conflict');
    rows.set(item.path, item);
  }
  for (const child of Object.values(value)) if (child && typeof child === 'object') await collectBindings(child, rows);
  return rows;
}

export class HostResponsePendingError extends Error {
  constructor(request_file, response_file) {
    super('host_response_pending'); this.code = 'host_response_pending';
    this.request_file = request_file; this.response_file = response_file;
  }
}

// This writes a declared host-authored result after the caller has actually reviewed the request.
// It neither invokes a model nor certifies audio listening or artistic qualification.
export async function writeHostResponse({ requestFile, value, backend, actual_input_processed, limitations = [] }) {
  if (actual_input_processed !== true) throw new Error('explicit_actual_input_review_required');
  const request = await readJson(requestFile), identity = resolveHostBackend(backend);
  if (!same(identity, request.backend)) throw new Error('host_response_backend_mismatch');
  if (request.request_sha256 !== shaBytes(canonical(request.payload))) throw new Error('host_request_changed');
  await verifyEvidenceBindings(request.payload.input_bindings);
  const schema = request.payload.input.schema ?? request.payload.input.response_schema;
  if (schema) validateSchema(value, schema);
  const requestBinding = await bound(requestFile);
  return saveJson(path.join(path.dirname(requestFile), 'response.json'), {
    schema_version: 1, request_sha256: request.request_sha256, backend: identity,
    input_bindings: request.payload.input_bindings, source_video_sha256: request.payload.source_video_sha256,
    input_sha256: request.payload.input_sha256 ?? null,
    model: identity.model_revision, backend_id: identity.backend_id, model_revision: identity.model_revision,
    actual_input_processed: true, actual_audio_processed: false, actual_video_processed: false,
    completion_status: 'complete', execution_kind: 'codex_host_authored_record',
    inference_claim: 'host_record_import_not_api_inference', qualified: false, scopes: [],
    artistic_approval: false, production_approval: false, limitations,
    evidence_files: [requestBinding, ...request.payload.input_bindings], value,
  });
}

export class HostFileSession {
  constructor({ directory, backend, media = [], observer = null, observerLedger = null, audioBackend = null, waitForResponse = null }) {
    this.directory = path.resolve(directory); this.backend = resolveHostBackend(backend);
    this.backend_kind = 'codex_host_file'; this.media = media; this.ledger = [];
    this.observer = observer; this.observerLedger = observerLedger;
    this.audioBackend = audioBackend; this.waitForResponse = waitForResponse;
  }
  async director(input) { return this.request(input.stage ?? 'director', input); }
  async request(role, input) {
    if (typeof role !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(role)) throw new Error('host_role_invalid');
    const input_bindings = [...(await collectBindings([this.media, input])).values()].sort((a, b) => a.path.localeCompare(b.path));
    if (!input_bindings.length) throw new Error('host_bound_input_required');
    await verifyEvidenceBindings(input_bindings);
    const source_video_sha256 = input.data?.source_video_sha256 ?? input.source_video_sha256 ?? null;
    if (source_video_sha256 && !input_bindings.some(row => row.sha256 === source_video_sha256))
      throw new Error('host_source_video_binding_required');
    const input_sha256 = input.input?.sha256 ?? null;
    if (input_sha256 && !input_bindings.some(row => row.sha256 === input_sha256))
      throw new Error('host_request_input_binding_required');
    const payload = { schema_version: 1, role, backend: this.backend, source_video_sha256, input_bindings, input,
      ...(input_sha256 ? { input_sha256 } : {}) };
    const request_sha256 = shaBytes(canonical(payload));
    const directory = path.join(this.directory, request_sha256), requestFile = path.join(directory, 'request.json');
    const responseFile = path.join(directory, 'response.json');
    const document = { schema_version: 1, request_sha256, backend: this.backend, payload };
    await mkdir(directory, { recursive: true });
    try { await saveJson(requestFile, document); }
    catch (error) { if (error.code !== 'EEXIST') throw error;
      if (!same(await readJson(requestFile), document)) throw new Error('host_request_changed'); }
    const requestBinding = await bound(requestFile);
    try { await readFile(responseFile); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (this.waitForResponse) await this.waitForResponse({ request_file: requestFile, response_file: responseFile, request_sha256 });
    }
    let response;
    try { response = await readJson(responseFile); }
    catch (error) { if (error.code === 'ENOENT') throw new HostResponsePendingError(requestFile, responseFile); throw error; }
    if (await hashFile(requestFile) !== requestBinding.sha256) throw new Error('host_request_changed');
    await verifyEvidenceBindings(input_bindings);
    if (response.schema_version !== 1 || response.request_sha256 !== request_sha256
      || !same(response.backend, this.backend) || response.model !== this.backend.model_revision
      || response.backend_id !== this.backend.backend_id || response.model_revision !== this.backend.model_revision
      || !same(response.input_bindings, input_bindings) || response.source_video_sha256 !== source_video_sha256
      || (response.input_sha256 ?? null) !== input_sha256
      || !same(response.evidence_files, [requestBinding, ...input_bindings])
      || response.actual_input_processed !== true || response.completion_status !== 'complete'
      || response.actual_audio_processed !== false || response.actual_video_processed !== false
      || response.execution_kind !== 'codex_host_authored_record' || response.inference_claim !== 'host_record_import_not_api_inference'
      || response.qualified !== false || !same(response.scopes, [])
      || response.artistic_approval !== false || response.production_approval !== false
      || !Array.isArray(response.limitations) || !response.limitations.every(row => typeof row === 'string'))
      throw new Error('host_response_binding_or_claim_invalid');
    const schema = input.schema ?? input.response_schema;
    if (schema) validateSchema(response.value, schema);
    const responseBinding = await bound(responseFile), receiptFile = path.join(directory, 'import-receipt.json');
    const receipt = { schema_version: 1, execution_kind: 'host_record_import', request: requestBinding,
      response: responseBinding, backend: this.backend, identity_evidence: 'host_declared_not_provider_verified',
      model_calls: 0, cloud_uploads: 0, cost_ceiling_usd: 0, formal_adoption_allowed: false };
    try { await saveJson(receiptFile, receipt); }
    catch (error) { if (error.code !== 'EEXIST') throw error;
      if (!same(await readJson(receiptFile), receipt)) throw new Error('host_imported_response_changed'); }
    if (!this.ledger.some(row => row.request_sha256 === request_sha256)) this.ledger.push({ ...receipt, stage: role, request_sha256 });
    return { ...response, raw_response: responseBinding, request_id: request_sha256 };
  }
  async observeAudio(job, directory, options) {
    if (!this.observer || !this.audioBackend) throw new Error('host_audio_observer_unavailable');
    await verifyEvidenceBindings([{ path: job.path, sha256: job.source_sha256 }, ...(options?.frames ?? [])]);
    const start = this.observerLedger?.length;
    try {
      const result = await this.observer(job, directory, options);
      if (!audioBackendMatches(result, this.audioBackend)) throw new Error('host_observer_backend_mismatch');
      if (result.source_sha256 !== job.source_sha256 || !same(result.source_range, job.source_range)
        || result.source_video_sha256 !== job.source_video_sha256 || !result.file?.sha256)
        throw new Error('host_observer_source_mismatch');
      await verifyEvidenceBindings([result.file, { path: job.path, sha256: job.source_sha256 }]);
      return result;
    } finally {
      if (Array.isArray(this.observerLedger)) this.ledger.push(...this.observerLedger.slice(start));
      else this.ledger.push({ execution_kind: 'external_observer_callback', accounting: 'not_reported',
        model_calls: null, cloud_uploads: null, cost_ceiling_usd: null });
    }
  }
}

export const createHostFileSession = options => new HostFileSession(options);
