"""Recompute bounded identity derivatives from actual sources; no HTTP or model."""
import argparse,asyncio,base64,hashlib,importlib.util,json,math,pathlib,shutil,subprocess,tempfile

def read(path):return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))
def sha_file(path):
 with pathlib.Path(path).open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()
def checked(binding):
 if sha_file(binding['path'])!=binding['sha256']:raise ValueError('derivative_binding_changed')
 return pathlib.Path(binding['path'])

async def fingerprint(input_file,uri_file,binary_file):
 from shazamio import Shazam
 value=read(input_file);source=checked(value['source']);expected=checked(value['input_audio'])
 start,end=value['window_seconds']
 if not 1<=end-start<=10:raise ValueError('fingerprint_window_invalid')
 with tempfile.TemporaryDirectory(prefix='identity-fingerprint-derivative-') as directory:
  output=pathlib.Path(directory)/'actual-source-window.wav'
  subprocess.run(['ffmpeg','-v','error','-nostdin','-n','-ss',str(start),'-i',str(source),'-t',str(end-start),
   '-map','0:a:0','-ac','1','-ar','16000','-c:a','pcm_s16le',str(output)],check=True,capture_output=True)
  if sha_file(output)!=sha_file(expected):raise ValueError('fingerprint_pcm_not_from_bound_source_window')
  client=Shazam(segment_duration_seconds=10)
  # The Rust core computes only a signature; the network-facing recognize/send method is never called.
  signature=await client.core_recognizer.recognize_path(value=str(output),options=None)
  uri=pathlib.Path(uri_file).read_text(encoding='utf-8')
  if signature.signature.uri!=uri:raise ValueError('signature_not_from_actual_input_pcm')
  binary=base64.b64decode(uri.split(',',1)[1],validate=True)
  if binary!=pathlib.Path(binary_file).read_bytes():raise ValueError('signature_binary_mismatch')
 checked(value['source']);checked(value['input_audio'])
 return {'verified':True,'actual_pcm_sha256':sha_file(expected),'signature_recomputed':True,'HTTP_calls':0,'model_calls':0}

def ncc(manifest_file):
 import numpy as np
 value=read(manifest_file)
 checked(value['producer']);checked(value['upstream']);checked(value['upstream_provenance']);checked(value['comparison_wrapper'])
 if value['sample_rate']!=11025 or value['bandpass_hz']!=[120,5000]:raise ValueError('pinned_parameters_required')
 directory=pathlib.Path(__file__).parent/'reference_fingerprint/candidate_upstream'
 provenance=read(directory/'UPSTREAM.json')
 for item in provenance['files']:
  if sha_file(directory/item['file'])!=item['sha256']:raise ValueError('pinned_upstream_changed')
 if value['upstream']['sha256']!=sha_file(directory/'compare_candidate.py') or value['upstream_revision']!=provenance['revision']:
  raise ValueError('pinned_algorithm_mismatch')
 spec=importlib.util.spec_from_file_location('trusted_pinned_pcm_derivation',directory/'compare_candidate.py')
 module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 cache={};bindings=[];verified=[]
 def verify(source,bounds,pcm):
  checked(source);expected=checked(pcm);bindings.extend([source,pcm])
  key=(source['sha256'],tuple(bounds))
  if key not in cache:
   samples=module.load_audio(pathlib.Path(source['path']),11025,120,5000,bounds[0],bounds[1]-bounds[0])
   array=np.asarray(samples,dtype='<f8')
   if not np.isfinite(array).all() or len(array)!=math.floor((bounds[1]-bounds[0])*11025+.5):raise ValueError('actual_pcm_range_invalid')
   cache[key]=hashlib.sha256(array.tobytes()).hexdigest()
  if cache[key]!=sha_file(expected):raise ValueError('pcm_not_from_pinned_actual_source_range')
  verified.append({'source_sha256':source['sha256'],'range':bounds,'pcm_sha256':cache[key]})
 for row in value['queries']:
  verify(row['query_source'],row['query_range'],row['query_pcm'])
  for candidate in row['candidates']:verify(candidate['source'],candidate['source_range'],candidate['pcm'])
 for binding in bindings:checked(binding)
 return {'verified':True,'derivatives':verified,'unique_derivative_count':len(cache),'producer_checked':True,
  'HTTP_calls':0,'model_calls':0,'GPU_forwards':0,'new_NCC_curve_computations':0}

def main():
 parser=argparse.ArgumentParser();group=parser.add_mutually_exclusive_group(required=True)
 group.add_argument('--fingerprint-input');group.add_argument('--pcm-manifest')
 parser.add_argument('--signature-uri');parser.add_argument('--signature-binary')
 args=parser.parse_args()
 try:
  if args.fingerprint_input:
   if not args.signature_uri or not args.signature_binary:raise ValueError('actual_signature_bindings_required')
   result=asyncio.run(fingerprint(args.fingerprint_input,args.signature_uri,args.signature_binary))
  else:result=ncc(args.pcm_manifest)
  print(json.dumps(result))
 except Exception as error:
  print(json.dumps({'verified':False,'reason':str(error) if str(error).replace('_','').isalnum() else type(error).__name__}))
  raise SystemExit(1)
if __name__=='__main__':main()
