"""Measure resident real-index recall + SQLite metadata; no audio quality score."""
import argparse
import json
from pathlib import Path
import sqlite3
import time

import numpy as np
from clap_segment_features import ResidentRetriever, digest

QUERIES = [
    'urgent orchestral music, driving percussion, unresolved danger',
    'restrained low strings and sparse piano, sustained family tension',
    'warm intimate piano and gentle strings, grieving then hopeful reunion',
    'dark atmospheric pulses, uneasy supernatural anticipation',
    'commanding orchestral brass and drums, strategic power confrontation',
    'delicate guitar and warm vocals, longing romantic hesitation',
    'playful syncopated bass and light percussion, comic misdirection',
    'ascending energetic rock guitar and drums, determined personal awakening',
]


def benchmark(index, weights, database, out, rounds=25):
    started = time.perf_counter()
    resident = ResidentRetriever(index, weights, 'cpu')
    load_seconds = time.perf_counter()-started
    db = sqlite3.connect(Path(database).resolve().as_uri()+'?mode=ro', uri=True)
    durations, kernel, samples = [], [], []
    try:
        for text in QUERIES:
            resident.search(text)
        for repeat in range(rounds):
            for text in QUERIES:
                started = time.perf_counter()
                result = resident.search(text)
                ids = [r['asset_id'] for r in result['candidates']]
                metadata = dict(db.execute('SELECT asset_id,record_json FROM assets WHERE asset_id IN ('
                               +','.join('?' for _ in ids)+')', ids))
                if set(metadata) != set(ids):
                    raise ValueError('retrieved_asset_missing_from_current_library')
                parsed = [json.loads(metadata[identifier]) for identifier in ids]
                durations.append((time.perf_counter()-started)*1000)
                if not repeat:
                    samples.append({'query':text, 'candidate_ids':ids,
                                    'voice_evidence_labels':[a.get('fulltrack_voice_annotation',{}).get('label') for a in parsed]})
                query = resident.vectors[(repeat*8+len(durations)) % len(resident.records)]
                started = time.perf_counter()
                resident.search_vector(query)
                kernel.append((time.perf_counter()-started)*1000)
    finally:
        db.close()
    result = {'schema':'real-index-resident-retrieval-performance-v1',
              'index':str(Path(index).resolve()), 'database':str(Path(database).resolve()),
              'index_manifest_sha256':digest(Path(index)/'index.json'),
              'actual_vector_shape':list(resident.vectors.shape), 'vector_bytes':resident.vectors.nbytes,
              'encoded_unique_sources':resident.encoded_unique_sources,
              'distinct_sound_queries':len(QUERIES), 'measured_requests':len(durations),
              'startup_seconds':load_seconds,
              'warm_text_rank_sqlite_p50_ms':float(np.percentile(durations,50)),
              'warm_text_rank_sqlite_p95_ms':float(np.percentile(durations,95)),
              'warm_vector_kernel_p95_ms':float(np.percentile(kernel,95)),
              'target_warm_request_p95_ms':500, 'target_vector_kernel_p95_ms':100,
              'warm_request_target_pass':float(np.percentile(durations,95))<=500,
              'kernel_target_pass':float(np.percentile(kernel,95))<=100,
              'synthetic_vectors_used':False, 'audio_rehashed_per_query':False,
              'includes':['real_CPU_text_embedding','exact_cosine','family_dedup','top20','SQLite_asset_metadata'],
              'excludes':['video_analysis','API_latency','audio_decoding','artistic_audition','selected_source_hash_verification'],
              'samples':samples, 'artistic_approval':False}
    Path(out).write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ('index','weights','database','out'):
        parser.add_argument('--'+name,required=True,type=Path)
    args=parser.parse_args()
    result=benchmark(args.index,args.weights,args.database,args.out)
    print(json.dumps({k:v for k,v in result.items() if k!='samples'}),flush=True)


if __name__=='__main__':main()
