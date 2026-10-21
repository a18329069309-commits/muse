import { createHash } from 'node:crypto';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function expandCandidateEvidence(document) {
  if (!document.evidence_encoding) return structuredClone(document);
  const encoding = document.evidence_encoding, table = document.evidence_table ?? {};
  if (document.schema_version !== 2 || encoding.version !== 1) throw new Error('candidate_evidence_encoding_unsupported');
  for (const [id, binding] of Object.entries(table)) {
    const actual = createHash('sha256').update(JSON.stringify(canonical(binding))).digest('hex');
    if (actual !== id) throw new Error('candidate_evidence_identity_changed');
  }
  const walk = value => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== 'object') return value;
    if (value.evidence_refs && value.evidence_files) throw new Error('candidate_evidence_encoding_ambiguous');
    return Object.fromEntries(Object.entries(value).map(([key, item]) => key === 'evidence_refs'
      ? ['evidence_files', item.map(id => {
        if (!Object.hasOwn(table, id)) throw new Error('candidate_evidence_reference_missing');
        return structuredClone(table[id]);
      })] : [key, walk(item)]));
  };
  const result = walk(Object.fromEntries(Object.entries(document)
    .filter(([key]) => !['evidence_encoding', 'evidence_table'].includes(key))));
  result.schema_version = encoding.original_schema_version;
  return result;
}
