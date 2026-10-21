import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

// External catalogs contain licensed file references, never bundled music.
export function reconcileMusicLibrary(indexFile, supplementFiles, outFile) {
  const output = path.resolve(outFile);
  if (fs.existsSync(output)) throw new Error('Output already exists; choose a new catalog path.');
  const inputs = [indexFile, ...supplementFiles].map(file => path.resolve(file));
  const records = new Map();
  const sources = [];
  const changes = [];
  let base;
  for (const [number, file] of inputs.entries()) {
    const bytes = fs.readFileSync(file);
    const document = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
    if (number === 0) base = document;
    const tracks = Array.isArray(document) ? document : document.tracks;
    if (!Array.isArray(tracks) || (number === 0 && Array.isArray(document))) {
      throw new Error('Base index requires tracks; supplements accept a tracks object or record array.');
    }
    sources.push({ path: file, sha256: hash(bytes), records: tracks.length });
    const seen = new Set();
    for (const original of tracks) {
      if (!original || typeof original.track_id !== 'string' || !original.track_id.trim() || seen.has(original.track_id)) {
        throw new Error('Every input requires distinct, nonempty track_id values.');
      }
      seen.add(original.track_id);
      const update = { ...original };
      if (update.local_path) update.local_path = path.resolve(path.dirname(file), update.local_path);
      const previous = records.get(update.track_id);
      for (const field of ['source_family', 'source_sha256']) {
        if (Object.hasOwn(update, field)) {
          if (update[field] === null || update[field] === '') update[field] = null;
          else if (typeof update[field] !== 'string') throw new Error(`${field} must be a string or null.`);
          else update[field] = update[field].trim() || null;
        }
        if (previous?.[field] && Object.hasOwn(update, field) && previous[field] !== update[field]) {
          throw new Error(`Conflicting ${field} for ${update.track_id}; give distinct recordings distinct IDs.`);
        }
      }
      records.set(update.track_id, { ...previous, ...update });
      if (number > 0) changes.push({ track_id: update.track_id, operation: previous ? 'merged' : 'added' });
    }
  }
  const checks = [];
  for (const track of records.values()) {
    const file = track.local_path;
    let status = 'metadata_only';
    const check = { track_id: track.track_id, path: file ?? null };
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      const digest = hash(fs.readFileSync(file));
      check.actual_sha256 = digest;
      if (track.source_sha256 && digest !== track.source_sha256) {
        status = 'hash_mismatch';
      } else {
        const result = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'format=duration:stream=sample_rate,channels', '-of', 'json', file], { encoding: 'utf8' });
        if (result.error?.code === 'ENOENT') throw new Error('ffprobe is required on PATH.');
        let probe;
        try { probe = JSON.parse(result.stdout || '{}'); } catch { probe = {}; }
        const audio = probe.streams?.[0];
        const duration = Number(probe.format?.duration);
        if (result.status === 0 && audio && Number(audio.sample_rate) > 0 && audio.channels > 0 && duration > 0 && Number.isFinite(duration)) {
          status = 'cached_not_auditory_approved';
          Object.assign(track, { source_sha256: digest, duration_seconds: duration, sample_rate_hz: Number(audio.sample_rate), channels: audio.channels });
        } else status = 'invalid_audio';
      }
    } else if (file) status = 'missing_file';
    if (file && status !== 'cached_not_auditory_approved') {
      // The existing searcher rechecks existence: remove unusable paths from its candidate field.
      track.unusable_local_path = file;
      track.local_path = null;
    }
    track.cache_status = status;
    track.style_family_status = track.source_family ? 'declared_not_auditory_verified' : 'missing_not_eligible_for_family_comparison';
    track.listening_status ??= 'pending';
    checks.push({ ...check, status });
  }
  const cached = [...records.values()].filter(track => track.cache_status === 'cached_not_auditory_approved');
  const result = { ...base, tracks: [...records.values()], cache_count: cached.length,
    reconciliation: { schema_version: 1, purpose: 'file_integrity_and_audio_probe_not_artistic_acceptance', sources, changes, checks,
      cached_recordings: cached.length, cached_unique_hashes: new Set(cached.map(track => track.source_sha256)).size,
      cached_explicit_families: new Set(cached.map(track => track.source_family).filter(Boolean)).size,
      cached_without_family: cached.filter(track => !track.source_family).map(track => track.track_id),
      unusable_count: checks.filter(check => ['hash_mismatch', 'invalid_audio', 'missing_file'].includes(check.status)).length,
    } };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { index: { type: 'string' }, supplement: { type: 'string', multiple: true, default: [] }, out: { type: 'string' } } });
    if (!values.index || !values.out) throw new Error('Usage: node reconcile_music_library.mjs --index INDEX --supplement RECORDS --out NEW_INDEX');
    const result = reconcileMusicLibrary(values.index, values.supplement, values.out);
    console.log(JSON.stringify({ output: path.resolve(values.out), ...result.reconciliation }, null, 2));
    if (result.reconciliation.unusable_count) process.exitCode = 2;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
