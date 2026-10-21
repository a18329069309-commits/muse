import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hashFile } from './render_binding.mjs';

export const publicReferenceIdentityContract = 'public_fingerprint_with_local_controls_v1';
export const publicReferenceIdentityPolicy = Object.freeze({ minimum_ncc: .35, maximum_control_ncc: .15,
  minimum_control_margin: .20, minimum_peak_ratio: 4, maximum_clock_error_seconds: .02 });
const fail = reason => { throw Error(`public_reference_${reason}`); };
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const range = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[0] >= 0 && r[1] > r[0];
const inside = (r,a) => range(r) && range(a) && r[0] >= a[0]-1e-12 && r[1] <= a[1]+1e-12;
const close = (a,b,tolerance=.02) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a-b) <= tolerance;
const sameRange = (a,b) => range(a)&&range(b)&&a.every((v,i)=>close(v,b[i],1/48000));
const execute=promisify(execFile),here=path.dirname(fileURLToPath(import.meta.url));
const trustedFingerprintPython=process.env.SDR_FINGERPRINT_PYTHON??(process.platform==='win32'
  ?'python':'python3');
const trustedNccPython=process.env.SDR_IDENTITY_PYTHON??(process.platform==='win32'
  ?'python':'python3');
async function resolveTrustedPython(command){
  if(typeof command!=='string'||!command)fail('trusted_python_executable_required');
  if(path.isAbsolute(command))return path.resolve(command);
  // Resolve PATH commands before hashing. A command name is not a binary
  // identity; runtime evidence must still bind this exact executable.
  let result;
  try{result=await execute(process.platform==='win32'?'where.exe':'which',[command],
    {windowsHide:true,encoding:'utf8'});}catch{fail('trusted_python_executable_not_found');}
  const file=result.stdout.trim().split(/\r?\n/)[0];
  if(!path.isAbsolute(file))fail('trusted_python_absolute_executable_required');
  return path.resolve(file);
}
const derivativeChecks=new Map();
const loadJson = async file => JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
async function bound(value, base) {
  if (!value?.path || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) fail('binding_required');
  const file = path.resolve(base,value.path);
  if (await hashFile(file) !== value.sha256) fail('binding_changed');
  return { path:file,sha256:value.sha256 };
}
async function document(value,base) {
  const binding = await bound(value,base);
  return { binding, value:await loadJson(binding.path),base:path.dirname(binding.path) };
}
async function verifyRuntimeBinaries(record,base,python) {
  const binary=await bound(record.python_binary,base),ffmpeg=await bound(record.ffmpeg_binary,base);
  if(path.resolve(binary.path)!==path.resolve(python)||binary.sha256!==await hashFile(python)) fail('trusted_python_binary_required');
  const result=await execute(process.platform==='win32'?'where.exe':'which',['ffmpeg'],{windowsHide:true,encoding:'utf8'});
  const actual=result.stdout.trim().split(/\r?\n/)[0];
  if(ffmpeg.sha256!==await hashFile(actual)) fail('actual_ffmpeg_binary_required');
}
async function verifyDerivatives(python,args,provenanceSha) {
  // Reuse only within this process for the identical immutable input/verification code.
  // Each caller still hashes all source, PCM and runtime bindings before accepting identity.
  const key=JSON.stringify([await hashFile(python),await hashFile(path.join(here,'verify_reference_identity_derivatives.py')),
    await hashFile(args[1]),...await Promise.all(args.filter((_,i)=>i>1&&i%2===1).map(file=>hashFile(file))),args,provenanceSha]);
  if(derivativeChecks.has(key))return;
  let result;
  try {result=await execute(python,['-X','utf8',path.join(here,'verify_reference_identity_derivatives.py'),...args],
    {windowsHide:true,encoding:'utf8',maxBuffer:1024*1024});}
  catch(error){let reason;try{reason=JSON.parse(error.stdout).reason;}catch{}fail(reason??'actual_derivative_verification_failed');}
  if(JSON.parse(result.stdout).verified!==true)fail('actual_derivative_verification_failed');
  if(derivativeChecks.size>=32)derivativeChecks.delete(derivativeChecks.keys().next().value);
  derivativeChecks.set(key,true);
}
function summarizedHttpResponse(raw,inputSha,rawSha) {
  const track=raw.track??{},keys=['key','title','subtitle','url','isrc','genres'];
  const candidate=Object.fromEntries(keys.filter(key=>Object.hasOwn(track,key)).map(key=>[key,track[key]]));
  return {input_sha256:inputSha,raw_response_sha256:rawSha,response_keys:Object.keys(raw).sort(),
    matches:(raw.matches??[]).map(row=>Object.fromEntries(['id','offset','timeskew','frequencyskew'].filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))),
    candidate:Object.keys(candidate).length?candidate:null,
    recording_metadata:(track.sections??[]).filter(section=>section.type==='SONG').flatMap(section=>(section.metadata??[]).map(row=>({title:row.title??null,text:row.text??null}))),
    candidate_status:Object.keys(track).length?'candidate_unverified':'no_candidate',source_match_verified:false,
    lyrics_verified:false,music_candidate_qualified:false,production_approval:false};
}

// Read the actual signed NumPy curve, not a caller-authored peak summary. ZIP member names never become paths.
function numpyCurve(file) {
  let end=-1;
  for(let i=file.length-22;i>=Math.max(0,file.length-65557);i--) if(file.readUInt32LE(i)===0x06054b50){end=i;break;}
  if(end<0) fail('ncc_curve_archive_invalid');
  let at=file.readUInt32LE(end+16);
  for(let index=0;index<file.readUInt16LE(end+10);index++) {
    if(file.readUInt32LE(at)!==0x02014b50) fail('ncc_curve_archive_invalid');
    const method=file.readUInt16LE(at+10),size=file.readUInt32LE(at+20),unpacked=file.readUInt32LE(at+24);
    const nameLength=file.readUInt16LE(at+28),extra=file.readUInt16LE(at+30),comment=file.readUInt16LE(at+32);
    const name=file.toString('utf8',at+46,at+46+nameLength),offset=file.readUInt32LE(at+42);
    at+=46+nameLength+extra+comment;
    if(name!=='ncc.npy') continue;
    if(unpacked>64*1024*1024||file.readUInt32LE(offset)!==0x04034b50) fail('ncc_curve_archive_invalid');
    const start=offset+30+file.readUInt16LE(offset+26)+file.readUInt16LE(offset+28);
    const packed=file.subarray(start,start+size);
    const data=method===0?packed:method===8?inflateRawSync(packed,{maxOutputLength:64*1024*1024}):null;
    if(!data||data.length!==unpacked||data.toString('latin1',0,6)!=='\x93NUMPY') fail('ncc_curve_array_invalid');
    const version=data[6],headerStart=version===1?10:12;
    const headerSize=version===1?data.readUInt16LE(8):data.readUInt32LE(8);
    const header=data.toString('latin1',headerStart,headerStart+headerSize);
    const shape=header.match(/'shape':\s*\((\d+),\s*\)/);
    if(!/'descr':\s*'<f8'/.test(header)||!/'fortran_order':\s*False/.test(header)||!shape) fail('ncc_curve_array_invalid');
    const samples=data.subarray(headerStart+headerSize),count=Number(shape[1]);
    if(samples.length!==count*8||count<2) fail('ncc_curve_array_invalid');
    return samples;
  }
  fail('ncc_curve_array_missing');
}
function pcmNcc(query,source,start) {
  const count=query.length/8;
  if(!Number.isSafeInteger(start)||start<0||start+count>source.length/8) fail('pcm_peak_outside_source');
  let q=0,s=0,qq=0,ss=0,qs=0;
  for(let i=0;i<count;i++) {
    const a=query.readDoubleLE(i*8),b=source.readDoubleLE((start+i)*8);
    if(!Number.isFinite(a)||!Number.isFinite(b)) fail('pcm_nonfinite');
    q+=a;s+=b;qq+=a*a;ss+=b*b;qs+=a*b;
  }
  const denominator=Math.sqrt((qq-q*q/count)*(ss-s*s/count));
  if(!(denominator>0)) fail('pcm_variance_missing');
  return (qs-q*s/count)/denominator;
}
async function fingerprint(ref,base,expectedSource,expectedRange,requireCandidate=true,strict=true) {
  const receipt=await document(ref,base),r=receipt.value;
  if(r.http_requests!==1||r.http_status!==200||!['candidate_unverified','no_candidate'].includes(r.status)) fail('actual_http_receipt_required');
  const input=await document(r.input,receipt.base),metadata=await document(r.candidate_evidence,receipt.base);
  const runtime=await document(r.runtime,receipt.base),submission=await document(r.submission,receipt.base),response=await document(r.response,receipt.base);
  const source=await bound(input.value.source,input.base);
  await bound(input.value.input_audio,input.base);await bound(input.value.public_source_provenance,input.base);
  if(source.sha256!==expectedSource.sha256||expectedRange&&!same(input.value.window_seconds,expectedRange)
    ||!range(input.value.window_seconds)||!['official_public_recording','public_research_video'].includes(input.value.source_kind)) fail('fingerprint_input_mismatch');
  if(response.value.status!==200||submission.value.service!=='Shazam'||submission.value.method!=='POST'
    ||submission.value.endpoint_origin!=='https://amp.shazam.com'||submission.value.body_contains_raw_media!==false
    ||!close(submission.value.signature_samplems/1000,input.value.window_seconds[1]-input.value.window_seconds[0],.002)) fail('fingerprint_submission_mismatch');
  const uri=await bound(submission.value.signature_uri,submission.base),binary=await bound(submission.value.fingerprint_binary,submission.base);
  await bound(runtime.value.runner,runtime.base);
  for(const file of runtime.value.sdk_source_bindings??[]) await bound(file,runtime.base);
  if(strict) {
    const http=await bound(response.value.raw_response,response.base),payload=await bound(submission.value.request_payload,submission.base);
    const bytes=await readFile(http.path),request=await loadJson(payload.path),rawHttp=JSON.parse(bytes.toString('utf8'));
    if(response.value.bytes!==bytes.length||response.value.raw_response_sha256!==http.sha256
      ||response.value.input_sha256!==input.binding.sha256||submission.value.input_sha256!==input.binding.sha256
      ||(await bound(submission.value.input,submission.base)).sha256!==input.binding.sha256
      ||(await bound(response.value.request_payload,response.base)).sha256!==payload.sha256
      ||submission.value.payload_sha256!==payload.sha256
      ||request.signature?.uri!==(await readFile(uri.path,'utf8'))||request.signature?.samplems!==submission.value.signature_samplems
      ||!same(metadata.value,summarizedHttpResponse(rawHttp,input.binding.sha256,http.sha256))) fail('http_candidate_input_binding_mismatch');
    const python=await resolveTrustedPython(trustedFingerprintPython);
    await verifyRuntimeBinaries(runtime.value,runtime.base,python);
    await verifyDerivatives(python,['--fingerprint-input',input.binding.path,'--signature-uri',uri.path,'--signature-binary',binary.path],runtime.binding.sha256);
  }
  const value=metadata.value,candidate=value.candidate;
  if(!requireCandidate) return {input:input.value,candidate,matches:value.matches};
  const match=value.matches?.find(m=>String(m.id)===String(candidate?.key));
  if(r.status!=='candidate_unverified'||!candidate?.key||!match||!Number.isFinite(match.offset)) fail('same_recording_fingerprint_required');
  return {input:input.value,candidate,match};
}

export async function validatePublicFingerprintSequence({receipts,base,reference,allowLegacyNegativeEvidence=false}) {
  if(!Array.isArray(receipts)||receipts.length<2||receipts.length>3) fail('two_neighboring_fingerprints_required');
  const rows=[];
  for(const receipt of receipts) {
    const current=await fingerprint(receipt,base,reference,null,true,!allowLegacyNegativeEvidence),prior=rows.at(-1);
    if(prior&&(current.candidate.key!==prior.candidate.key||current.candidate.isrc&&prior.candidate.isrc&&current.candidate.isrc!==prior.candidate.isrc
      ||!close(current.input.window_seconds[0],prior.input.window_seconds[1],1/48000)
      ||!close(current.match.offset-prior.match.offset,current.input.window_seconds[0]-prior.input.window_seconds[0])))
      fail('neighboring_offset_inconsistent');
    rows.push(current);
  }
  return rows;
}

async function actualNccMeasurements({comparison,pcm,source,interval}) {
  const c=comparison.value,p=pcm.value;
  if(c.operation!=='candidate_recording_comparison'||c.query_sha256!==source.sha256||!sameRange(c.source_range,interval)
    ||c.sample_rate!==p.sample_rate||!same(c.bandpass_hz,p.bandpass_hz)||c.upstream_revision!==p.upstream_revision) fail('local_comparison_input_mismatch');
  const win=p.queries?.find(w=>sameRange(w.query_range,interval));
  if(!win||(await bound(win.raw_comparison_result,pcm.base)).sha256!==comparison.binding.sha256
    ||(await bound(win.query_source,pcm.base)).sha256!==source.sha256) fail('pcm_comparison_binding_mismatch');
  const queryPcm=await readFile((await bound(win.query_pcm,pcm.base)).path);
  if(queryPcm.length/8!==Math.round((interval[1]-interval[0])*11025)) fail('pcm_query_range_mismatch');
  const results=[];
  for(const candidate of c.candidates??[]) {
    const row=win.candidates?.find(r=>r.asset_id===candidate.asset_id&&r.source.sha256===candidate.sha256);
    if(!row||(await bound(row.source,pcm.base)).sha256!==candidate.sha256||!same(row.source_range,candidate.source_range)) fail('pcm_source_binding_mismatch');
    const measure=candidate.comparisons?.find(m=>m.variant==='original_bandpass'&&m.status==='measured');
    if(!measure||!range(candidate.source_range)) fail('measured_original_bandpass_required');
    const sourcePcm=await readFile((await bound(row.pcm,pcm.base)).path);
    if(sourcePcm.length/8!==Math.round((candidate.source_range[1]-candidate.source_range[0])*11025)) fail('pcm_source_range_mismatch');
    const curve=numpyCurve(await readFile((await bound(row.full_array,pcm.base)).path));
    if(curve.length/8!==sourcePcm.length/8-queryPcm.length/8+1) fail('ncc_curve_length_mismatch');
    let peak=0,absolute=-1;
    for(let j=0;j<curve.length/8;j++){const score=Math.abs(curve.readDoubleLE(j*8));if(!Number.isFinite(score)||score>1.0001)fail('ncc_curve_invalid');if(score>absolute){absolute=score;peak=j;}}
    const peakSeconds=candidate.source_range[0]+peak/11025;
    if(!close(absolute,measure.best_absolute_ncc,1e-9)||!close(peakSeconds,measure.query_start_maps_to_source_seconds,1/11025)
      ||!close(measure.query_end_maps_to_source_seconds,peakSeconds+(interval[1]-interval[0]),2/11025)
      ||!close(pcmNcc(queryPcm,sourcePcm,peak),curve.readDoubleLE(peak*8),1e-7)) fail('ncc_raw_peak_mismatch');
    const qn=queryPcm.length/8,low=Math.max(0,peak-qn),high=Math.min(curve.length/8,peak+qn+1);
    let count=0,less=0,equal=0;
    for(let j=0;j<curve.length/8;j++) if(j<low||j>=high){count++;const value=Math.abs(curve.readDoubleLE(j*8));if(value<measure.other_positions_abs_p99)less++;else if(value===measure.other_positions_abs_p99)equal++;}
    const percentile=(count-1)*.99;
    if(count!==measure.independent_background_positions||count<1000||less>Math.ceil(percentile)+1
      ||less+equal<Math.floor(percentile)||!(measure.other_positions_abs_p99>0)) fail('ncc_background_mismatch');
    results.push({candidate,score:absolute,mapped:peakSeconds,background_p99:measure.other_positions_abs_p99});
  }
  return results;
}

// This identity policy is scoped to the explicitly supplied evidence. It grants no listening or model qualification.
export async function validatePublicReferenceIdentity({raw,evidence,base,reference,source,query,timelineRange}) {
  if(raw.schema_version!==1||raw.operation!==publicReferenceIdentityContract
    ||evidence.identification_contract!==publicReferenceIdentityContract||raw.query_sha256!==query.sha256
    ||!same(raw.query_source_range,evidence.reference_audio_source_range)
    ||!Array.isArray(raw.reference_fingerprints)||raw.reference_fingerprints.length<2||raw.reference_fingerprints.length>3
    ||raw.local_comparisons?.length!==raw.reference_fingerprints.length) fail('contract_required');
  if((await bound(raw.reference_video,base)).sha256!==reference.sha256
    ||(await bound(raw.source_audio,base)).sha256!==source.sha256) fail('source_mismatch');
  const acquisition=await document(raw.recording_acquisition,base),official=await bound(raw.official_metadata,base);
  if((await bound(acquisition.value.material,acquisition.base)).sha256!==source.sha256
    ||acquisition.value.full_decode_success!==true
    ||(await bound(acquisition.value.official_metadata,acquisition.base)).sha256!==official.sha256) fail('independent_recording_acquisition_required');
  await bound(acquisition.value.original_acquisition,acquisition.base);
  const clean=await fingerprint(raw.recording_fingerprint,base,source);
  if(clean.input.source_kind!=='official_public_recording'
    ||!clean.candidate.isrc||!close(clean.match.timeskew,0,.002)||!close(clean.match.frequencyskew,0,.002)
    ||(await bound(clean.input.official_metadata,base)).sha256!==official.sha256) fail('independent_recording_fingerprint_required');
  const pcm=await document(raw.local_pcm_evidence,base),p=pcm.value;
  if(p.operation!=='pinned_bandpass_pcm_for_ncc_v1'||p.sample_rate!==11025||!same(p.bandpass_hz,[120,5000])) fail('actual_pcm_evidence_required');
  await bound(p.upstream,pcm.base);
  await bound(p.producer,pcm.base);await bound(p.upstream_provenance,pcm.base);await bound(p.comparison_wrapper,pcm.base);
  const verifier=await bound(p.verification_producer,pcm.base);
  if(verifier.sha256!==await hashFile(path.join(here,'verify_reference_identity_derivatives.py'))) fail('trusted_derivative_verifier_required');
  const python=await resolveTrustedPython(trustedNccPython);
  await verifyRuntimeBinaries(p,pcm.base,python);
  await verifyDerivatives(python,['--pcm-manifest',pcm.binding.path],pcm.binding.sha256);
  const upstreamDirectory=path.join(path.dirname(fileURLToPath(import.meta.url)),'reference_fingerprint/candidate_upstream');
  const upstream=await loadJson(path.join(upstreamDirectory,'UPSTREAM.json'));
  if(p.upstream.sha256!==await hashFile(path.join(upstreamDirectory,'compare_candidate.py'))
    ||p.upstream_revision!==upstream.revision) fail('pinned_ncc_algorithm_required');
  const fingerprints=await validatePublicFingerprintSequence({receipts:raw.reference_fingerprints,base,reference});
  const supported=[],offsets=[];let priorEnd=null,priorOffset=null;
  for(let i=0;i<raw.reference_fingerprints.length;i++) {
    const fp=fingerprints[i];
    const interval=fp.input.window_seconds;
    if(fp.candidate.key!==clean.candidate.key||fp.candidate.isrc!==clean.candidate.isrc
      ||!close(fp.match.timeskew,0,.002)||!close(fp.match.frequencyskew,0,.002)
      ||!inside(interval,evidence.reference_range)||priorEnd!==null&&!close(interval[0],priorEnd,1/11025)) fail('neighboring_same_recording_required');
    const local=await document(raw.local_comparisons[i],base);
    const measurements=await actualNccMeasurements({comparison:local,pcm,source:reference,interval});
    const positive=measurements.find(row=>row.candidate.sha256===source.sha256);
    if(!positive) fail('local_original_missing');
    const positiveScore=positive.score,mapped=positive.mapped;
    if(positiveScore<.35||positiveScore/positive.background_p99<4)fail('ncc_positive_below_policy');
    const controls=measurements.filter(row=>row.candidate.sha256!==source.sha256);
    const identities=new Set(measurements.map(row=>row.candidate.sha256));
    const roleHashes=['same_composition_wrong_version','unrelated_recording'].map(kind=>p.controls?.find(control=>
      control.kind===kind&&controls.some(c=>c.candidate.sha256===control.source.sha256))?.source.sha256);
    if(identities.size<3||controls.length<2||roleHashes.some(value=>!value)||new Set(roleHashes).size!==2) fail('two_distinct_controls_required');
    for(const control of controls) {
      const score=control.score;
      if(score>.15||positiveScore-score<.20||positiveScore/Math.max(score,1e-12)<4) fail('positive_control_separation_required');
    }
    const nccOffset=mapped-interval[0],fingerprintSource=clean.input.window_seconds[0]+fp.match.offset-clean.match.offset;
    if(!close(mapped,fingerprintSource)||priorOffset!==null&&!close(nccOffset,priorOffset)
      ||priorEnd!==null&&!close(fp.match.offset-offsets.at(-1),interval[0]-supported.at(-1).reference_range[0])) fail('neighboring_offset_inconsistent');
    supported.push({reference_range:interval,source_range:[mapped,mapped+interval[1]-interval[0]],offset:nccOffset});
    offsets.push(fp.match.offset);priorEnd=interval[1];priorOffset=nccOffset;
  }
  const use=evidence.reference_case_use_range,clock=evidence.reference_clock;
  if(!same(use,timelineRange)||!range(use)||!Number.isFinite(clock?.offset_seconds)) fail('use_clock_required');
  const audioUse=use.map(v=>v-clock.offset_seconds),first=supported[0],last=supported.at(-1);
  if(!inside(audioUse,[first.reference_range[0],last.reference_range[1]])) fail('use_outside_verified_support');
  const allowed=[audioUse[0]+first.offset,audioUse[1]+last.offset];
  if(!inside(evidence.source_range,allowed)) fail('source_outside_case_use_support');
  const sourceSpans=supported.map(window=>{
    const start=Math.max(audioUse[0],window.reference_range[0]),end=Math.min(audioUse[1],window.reference_range[1]);
    return start<end?[start+window.offset,end+window.offset]:null;
  }).filter(Boolean).sort((a,b)=>a[0]-b[0]);
  let covered=evidence.source_range[0];
  for(const span of sourceSpans) if(span[0]<=covered+1e-12&&span[1]>covered) covered=span[1];
  if(covered<evidence.source_range[1]-1e-12) fail('source_support_union_has_gap');
  const negative=raw.negative_control;
  if(!negative) fail('unknown_reference_control_required');
  const negativeSource=await bound(negative.reference_video,base);
  if(negativeSource.sha256===reference.sha256) fail('unknown_reference_control_required');
  const nc=await document(negative.local_comparison,base);
  if(negative.verification_kind!=='actual_pinned_pcm_ncc_only'||nc.value.query_sha256!==negativeSource.sha256
    ||!sameRange(nc.value.source_range,negative.reference_range)) fail('unknown_control_not_excluded');
  const negativeMeasurements=await actualNccMeasurements({comparison:nc,pcm,source:negativeSource,interval:nc.value.source_range});
  const negativeCandidate=negativeMeasurements.find(row=>row.candidate.sha256===source.sha256);
  if(!negativeCandidate||negativeCandidate.score>.15) fail('unknown_control_not_excluded');
  return {contract:publicReferenceIdentityContract,supported_windows:supported,case_use_range:use,
    allowed_source_range:allowed,actual_source_support_spans:sourceSpans,policy:publicReferenceIdentityPolicy,identity_only:true,
    audio_listening_approved:false,plot_applicability_approved:false,qualification_granted:false};
}
