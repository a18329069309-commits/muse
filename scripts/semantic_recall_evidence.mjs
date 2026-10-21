import path from 'node:path';
import { readJson, verifyEvidenceBindings } from './audio_api.mjs';

// Only declared execution-code identities can use an explicit historical copy.
// Original receipts and every non-code evidence binding remain unchanged.
export async function verifySemanticSourceInputs(receiptBinding, receipt, histories = []) {
  await verifyEvidenceBindings(receiptBinding);
  const inputs = structuredClone(receipt.source_inputs), used = [];
  for (const binding of histories) {
    await verifyEvidenceBindings(binding);
    const proof = await readJson(binding.path);
    if (proof.receipt?.sha256 !== receiptBinding.sha256) continue;
    if (used.length || proof.schema_version !== 1 || proof.kind !== 'semantic_execution_history_v1'
      || proof.research_only !== true || proof.artistic_approval !== false || proof.production_approval !== false
      || path.resolve(proof.receipt.path ?? '') !== path.resolve(receiptBinding.path)
      || !Array.isArray(proof.code_snapshots) || !proof.code_snapshots.length)
      throw new Error('semantic_historical_code_proof_mismatch');
    await verifyEvidenceBindings(proof.receipt);
    const fields = new Set();
    for (const row of proof.code_snapshots) {
      const original = inputs?.[row.source_field];
      if (!['execution_script', 'semantic_helper'].includes(row.source_field) || fields.has(row.source_field)
        || !original?.sha256 || row.original?.sha256 !== original.sha256
        || path.resolve(row.original?.path ?? '') !== path.resolve(original.path)
        || row.snapshot?.sha256 !== original.sha256 || row.relative_path !== 'scripts/semantic_material_recall.py'
        || !row.migration?.path || !row.migration.sha256 || !row.snapshot?.path
        || path.resolve(row.snapshot.path) !== path.resolve(path.dirname(row.migration.path), 'previous', row.relative_path))
        throw new Error('semantic_historical_code_proof_mismatch');
      await verifyEvidenceBindings([row.snapshot, row.migration]);
      const migration = await readJson(row.migration.path);
      if (!migration.files?.some(file => file.path === row.relative_path && file.previous_sha256 === original.sha256
        && /^[a-f0-9]{64}$/.test(file.source_sha256 ?? '') && file.source_sha256 === file.installed_sha256 && file.match === true))
        throw new Error('semantic_historical_code_proof_mismatch');
      inputs[row.source_field] = row.snapshot; fields.add(row.source_field);
    }
    used.push(binding);
  }
  await verifyEvidenceBindings(inputs);
  let executionRevision = null;
  if (receipt.execution_code_snapshot) {
    await verifyEvidenceBindings(receipt.execution_code_snapshot);
    const code = await readJson(receipt.execution_code_snapshot.path);
    executionRevision = code.revision;
    const expectedDependencies = code.revision === 'semantic-execution-code-v1'
      ? ['clap_segment_features.py', 'route_music_cues.py', 'segment_library.py']
      : code.revision === 'semantic-execution-code-v2'
        ? ['clap_segment_features.py', 'registered_library_connection.py', 'route_music_cues.py', 'segment_library.py'] : null;
    if (!expectedDependencies
      || JSON.stringify(code.execution_script) !== JSON.stringify(receipt.source_inputs.execution_script)
      || JSON.stringify(code.dependencies) !== JSON.stringify(receipt.source_inputs.execution_dependencies)
      || !Array.isArray(code.dependencies) || code.dependencies.length !== expectedDependencies.length
      || code.dependencies.map(row => path.basename(row.path)).sort().join(',') !== expectedDependencies.join(','))
      throw new Error('semantic_execution_code_snapshot_mismatch');
  }
  if (receipt.library_storage) {
    if (executionRevision !== 'semantic-execution-code-v2') throw new Error('semantic_registered_library_execution_snapshot_required');
    const storage = receipt.library_storage;
    await verifyEvidenceBindings([receipt.library, storage.descriptor, storage.base_db, storage.delta_db]);
    const descriptor = await readJson(storage.descriptor.path);
    const same = (a, b) => a?.sha256 === b?.sha256 && path.resolve(a?.path ?? '') === path.resolve(b?.path ?? '');
    if (storage.schema_version !== 1 || storage.kind !== 'frozen_base_registered_windows'
      || descriptor.schema_version !== 1 || descriptor.kind !== storage.kind
      || !same(receipt.library, storage.descriptor) || !same(descriptor.base_db, storage.base_db)
      || !same(descriptor.delta_db, storage.delta_db) || !same(storage.base_db, receipt.source_inputs.library_db)
      || path.resolve(storage.base_db.path) === path.resolve(storage.delta_db.path))
      throw new Error('semantic_registered_library_storage_mismatch');
  } else if (path.extname(receipt.library?.path ?? '').toLowerCase() === '.json') {
    throw new Error('semantic_registered_library_storage_required');
  }
  return used;
}
