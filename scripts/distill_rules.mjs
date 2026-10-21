import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readJson, saveJson, objectSchema, validateSchema, verifyEvidenceBindings } from './audio_api.mjs';
import { hashFile } from './render_binding.mjs';

const str = { type: 'string' }, strings = { type: 'array', items: str };
export const ruleSynthesisSchema = objectSchema({ rules: { type: 'array', items: objectSchema({
  rule_id: str, principle: str, applicable_when: strings, contraindications: strings,
  examples: { type: 'array', items: objectSchema({ case_id: str, development_step_ids: strings }) },
  limitations: strings,
}) }, unresolved_gaps: strings });

export async function verifyRuleCandidateEvidence(rules) {
  const files = new Map(); let references = 0, bytes = 0;
  const unchanged = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);
  for (const candidate of rules) for (const file of [candidate.source_video, ...(candidate.evidence_files ?? [])].filter(Boolean)) {
    references++;
    if (typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256 ?? ''))
      throw new Error('rule_candidate_evidence_changed');
    const resolved = path.resolve(file.path), key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    const previous = files.get(key);
    if (previous && previous.sha256 !== file.sha256) throw new Error('rule_candidate_evidence_sha_conflict');
    if (!previous) files.set(key, { path: resolved, sha256: file.sha256 });
  }
  for (const file of files.values()) {
    const before = await stat(file.path, { bigint: true }), digest = await hashFile(file.path);
    const after = await stat(file.path, { bigint: true });
    if (digest !== file.sha256 || !unchanged(before, after)) throw new Error('rule_candidate_evidence_changed');
    file.stamp = after; bytes += Number(after.size);
  }
  for (const file of files.values()) if (!unchanged(file.stamp, await stat(file.path, { bigint: true })))
    throw new Error('rule_candidate_evidence_changed');
  return { binding_references: references, unique_files_hashed: files.size, bytes_hashed: bytes, cache_scope: 'this_call_only' };
}

// Nuwa receives bound cases, not an instruction to invent what unseen source videos sound like.
export async function synthesizeRules({ candidates_file, output_dir, pending_input }, runtime = {}) {
  const source = { path: path.resolve(candidates_file), sha256: await hashFile(candidates_file) };
  const candidates = await readJson(source.path);
  if (candidates.schema_version !== 1 || !Array.isArray(candidates.rules) || candidates.heldout_excluded !== true)
    throw new Error('bound_rule_candidates_required');
  const evidenceVerification = await verifyRuleCandidateEvidence(candidates.rules);
  const byCase = new Map();
  for (const candidate of candidates.rules) for (const caseId of candidate.case_ids) {
    if (byCase.has(caseId)) throw new Error('duplicate_rule_case_identity');
    byCase.set(caseId, candidate);
  }
  const out = path.resolve(output_dir);
  const request = {
    schema_version: 1, source,
    prompt: '使用女娲主题蒸馏方法，从这些有实际声画依据的案例提炼条件规则与失败边界。'
      + '分别处理人物关系、观众知情、主动权、威胁是否解除、音乐蓄压与兑现、歌句词义和音效作用。'
      + '只能引用提供的case_id和有序development_step_ids，不编造曲名、听到的歌词或案例。'
      + '研究预测保留不确定性；单案例不能证明跨剧通用。反例没有真实案例时只能写禁用条件，不能写已观察的失败。'
      + '采访结论与真实声音分开，流量不证明配乐有效，不自动批准素材或选曲。',
    candidates: candidates.rules, response_schema: ruleSynthesisSchema,
    backend_id: runtime.synthesizer_backend_id ?? null,
  };
  let input = pending_input;
  if (input) {
    if (await hashFile(input.path) !== input.sha256 || JSON.stringify(await readJson(input.path)) !== JSON.stringify(request))
      throw new Error('rule_synthesis_pending_input_changed');
  } else input = await saveJson(path.join(out, 'nuwa-request.json'), request);
  const record = { schema_version: 1, status: 'nuwa_synthesis_pending', input, source,
    evidence_verification: evidenceVerification,
    candidate_count: byCase.size, runtime_calls: 0, model_calls: 0, cloud_uploads: 0,
    production_approval: false, artistic_approval: false, nuwa_synthesis_completed: false };
  if (byCase.size && typeof runtime.synthesizer === 'function') {
    if (!runtime.synthesizer_backend_id?.trim()) throw new Error('synthesizer_backend_identity_required');
    record.runtime_calls = 1;
    const response = await runtime.synthesizer({ ...request, input }, out);
    record.cli_receipts = response.cli_receipts ?? [];
    await verifyEvidenceBindings(record.cli_receipts);
    record.cli_model_calls = record.cli_receipts.length;
    record.account_usage = await Promise.all(record.cli_receipts.map(async file => (await readJson(file.path)).usage ?? null));
    if (await hashFile(input.path) !== input.sha256 || await hashFile(source.path) !== source.sha256)
      throw new Error('rule_synthesis_input_changed');
    if (response?.input_sha256 !== input.sha256 || response.actual_input_processed !== true
      || !response.model?.trim() || !response.raw_response?.path
      || await hashFile(response.raw_response.path) !== response.raw_response.sha256)
      throw new Error('rule_synthesis_response_binding_required');
    const raw = await readJson(response.raw_response.path);
    if (raw.input_sha256 !== input.sha256 || raw.model !== response.model
      || JSON.stringify(raw.value) !== JSON.stringify(response.value)) throw new Error('rule_synthesis_raw_result_mismatch');
    const value = validateSchema(response.value, ruleSynthesisSchema), ids = new Set();
    const rules = value.rules.map(rule => {
      if (!rule.rule_id.trim() || ids.has(rule.rule_id) || !rule.principle.trim() || !rule.examples.length
        || !rule.applicable_when.length || !rule.contraindications.length || !rule.limitations.length)
        throw new Error('conditional_rule_and_bound_examples_required');
      ids.add(rule.rule_id);
      const sourceCases = rule.examples.map(example => {
        const candidate = byCase.get(example.case_id);
        if (!candidate || !example.development_step_ids.length) throw new Error('rule_example_case_not_in_input');
        const positions = new Map(candidate.sound_development.steps.map((step, i) => [step.step_id, i]));
        let last = -1;
        for (const step of example.development_step_ids) {
          const next = positions.get(step);
          if (next === undefined || next <= last) throw new Error('rule_example_step_order_or_identity_invalid');
          last = next;
        }
        return candidate;
      });
      return { ...rule, case_ids: rule.examples.map(example => example.case_id),
        source_case_evidence: sourceCases.map(candidate => ({ case_ids: candidate.case_ids,
          source_video: candidate.source_video ?? null,
          source_video_sha256: candidate.source_video_sha256, source_range: candidate.source_range,
          evidence_files: candidate.evidence_files, source_observation_status: candidate.source_observation_status })),
        status: 'research', production_approval: false, cross_work_validation: 'not_performed' };
    });
    record.rules = await saveJson(path.join(out, 'director-rules.json'), {
      schema_version: 1, rules, unresolved_gaps: value.unresolved_gaps,
      source, input, raw_response: response.raw_response, model: response.model,
      heldout_excluded: true, production_approval: false, artistic_approval: false,
    });
    record.raw_response = response.raw_response;
    record.status = rules.length ? 'research_rules_synthesized' : 'nuwa_synthesis_gap';
    record.rule_count = rules.length;
    record.nuwa_synthesis_completed = rules.length > 0;
  }
  await saveJson(path.join(out, 'rule-synthesis-record.json'), record);
  return record;
}
