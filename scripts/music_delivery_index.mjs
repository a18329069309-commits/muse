import path from 'node:path';
import { mkdir, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

const synchronized = new Set();
export async function openMusicDeliveryIndex(root) {
  const directory = path.join(root, '.delivery-index'); await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'deliveries.sqlite'), db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS deliveries(receipt_sha TEXT PRIMARY KEY,receipt_path TEXT NOT NULL,
      work_id TEXT,source_sha TEXT,arrangement TEXT,delivered_at TEXT,summary_json TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS arrangements ON deliveries(arrangement);
    CREATE TABLE IF NOT EXISTS delivery_recordings(receipt_sha TEXT NOT NULL,recording_sha TEXT NOT NULL,
      PRIMARY KEY(receipt_sha,recording_sha));
    CREATE INDEX IF NOT EXISTS recordings ON delivery_recordings(recording_sha);`);
  return { db, file };
}

// Only the existing complete-render verifier may pass verified receipts to this cache.
export function indexVerifiedMusicDelivery(db, binding, summary, delivered_at = null) {
  if (!/^[a-f0-9]{64}$/.test(binding.sha256) || !summary?.source?.sha256 || !summary.work?.id)
    throw Error('music_delivery_index_verified_identity_required');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR IGNORE INTO deliveries VALUES(?,?,?,?,?,?,?)').run(binding.sha256, binding.path,
      summary.work.id, summary.source.sha256, summary.arrangement_fingerprint ?? null,
      delivered_at, JSON.stringify(summary));
    for (const recording of summary.recordings ?? []) {
      const add = key => db.prepare('INSERT OR IGNORE INTO delivery_recordings VALUES(?,?)').run(binding.sha256, key);
      add(`recording:${recording.recording_sha256}`);
      const family = summary.recording_family_by_sha256?.[recording.recording_sha256]?.family_id;
      if (family && summary.recording_family_by_sha256[recording.recording_sha256].identity_basis === 'hash_bound_verified_recording_family_membership')
        add(`family:${family}`);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

export async function syncMusicDeliveryIndex(root, db, verify, { refresh = false } = {}) {
  const key = path.resolve(root).toLowerCase();
  if (synchronized.has(key) && !refresh) return;
  const known = new Set(db.prepare('SELECT receipt_sha FROM deliveries').all().map(row => row.receipt_sha));
  for (const name of await readdir(root)) {
    if (!name.endsWith('.json')) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error('cross_work_music_history_filename_invalid');
    const binding = { path: path.resolve(root, name), sha256: name.slice(0, -5) };
    if (!known.has(binding.sha256)) {
      const history = await verify(binding);
      indexVerifiedMusicDelivery(db, binding, history, history.delivered_at ?? null);
    }
  }
  synchronized.add(key);
}

export function queryRelevantDeliveries(db, current, pinned = []) {
  const selected = new Map();
  const take = rows => { for (const row of rows) selected.set(row.receipt_sha, { path: row.receipt_path, sha256: row.receipt_sha }); };
  for (const recording of current?.recordings ?? []) {
    const lookup = key => take(db.prepare(`SELECT d.receipt_sha,d.receipt_path FROM deliveries d
      JOIN delivery_recordings r ON r.receipt_sha=d.receipt_sha WHERE r.recording_sha=?`).all(key));
    lookup(`recording:${recording.recording_sha256}`);
    const family = current.recording_family_by_sha256?.[recording.recording_sha256]?.family_id;
    if (family) lookup(`family:${family}`);
  }
  if (current?.arrangement_fingerprint) take(db.prepare('SELECT receipt_sha,receipt_path FROM deliveries WHERE arrangement=?')
    .all(current.arrangement_fingerprint));
  for (const binding of pinned) selected.set(binding.sha256, binding);
  return [...selected.values()];
}
