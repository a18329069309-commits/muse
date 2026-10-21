// Lossless shared record shapes: field names occur once; values stay inline.
// No precision change, string truncation, semantic summary or host-only fact.
const canonical=v=>JSON.stringify(v,(_,r)=>r&&typeof r==='object'&&!Array.isArray(r)?Object.fromEntries(Object.keys(r).sort().map(k=>[k,r[k]])):r);
export function encodeBoundedInlineRecords(value){
  const groups=new Map(),stringCounts=new Map();
  function collect(v){
    if(typeof v==='string'){stringCounts.set(v,(stringCounts.get(v)??0)+1);return;}
    if(Array.isArray(v)){if(['~','~s'].includes(v[0]))throw Error('bounded_inline_reserved_record_marker');v.forEach(collect);return;}
    if(!v||typeof v!=='object')return;
    const keys=Object.keys(v),id=canonical(keys),row=groups.get(id)??{keys,count:0};
    // Leave immutable evidence references visible to the existing host binder.
    // Encoding them before that binder would resubmit private path metadata.
    if(!(typeof v.path==='string'&&typeof v.sha256==='string')){row.count++;groups.set(id,row);}
    Object.values(v).forEach(collect);
  }
  collect(value);
  const shapes=[...groups.values()].filter(r=>r.count>1&&
    (JSON.stringify(r.keys).length-12)*r.count>JSON.stringify(r.keys).length+28).map(r=>r.keys);
  const lookup=new Map(shapes.map((keys,i)=>[canonical(keys),i]));
  const strings=[...stringCounts].filter(([s,count])=>count>1&&(JSON.stringify(s).length-10)*count>JSON.stringify(s).length+12).map(([s])=>s);
  const stringLookup=new Map(strings.map((s,i)=>[s,i]));
  function encode(v){
    if(typeof v==='string'&&stringLookup.has(v))return ['~s',stringLookup.get(v)];
    if(Array.isArray(v))return v.map(encode);
    if(!v||typeof v!=='object')return v;
    if(typeof v.path==='string'&&typeof v.sha256==='string')return structuredClone(v);
    if(v.encoding==='adjacent-exact-pcm-intervals-v1'&&v.rows?.length>2){
      const step=v.rows[1][0]-v.rows[0][0],first=v.rows[0][0];
      if(v.rows.every((row,index)=>row.length===3&&row[0]===first+index*step))
        return {encoding:'uniform-exact-pcm-starts-v1',first,step,end:v.final_source_end_seconds,
          values:v.rows.map(row=>[row[1],row[2]])};
    }
    const index=typeof v.path==='string'&&typeof v.sha256==='string'?undefined:lookup.get(canonical(Object.keys(v)));
    return index===undefined?Object.fromEntries(Object.entries(v).map(([key,row])=>[key,encode(row)]))
      :['~',index,...shapes[index].map(key=>encode(v[key]))];
  }
  const result={encoding:'shared-inline-record-shapes-v1',shapes,strings,value:encode(value)};
  if(canonical(expandBoundedInlineRecords(result))!==canonical(value))throw Error('bounded_inline_record_roundtrip_changed');
  return result;
}
export function expandBoundedInlineRecords(encoded){
  if(encoded?.encoding!=='shared-inline-record-shapes-v1'||!Array.isArray(encoded.shapes))throw Error('bounded_inline_record_encoding_required');
  if(encoded.shapes.some(keys=>!Array.isArray(keys)||new Set(keys).size!==keys.length||keys.some(k=>typeof k!=='string')))
    throw Error('bounded_inline_record_shape_invalid');
  function expand(v){
    if(Array.isArray(v)){
      if(v[0]==='~s'){
        if(v.length!==2||!Number.isInteger(v[1])||typeof encoded.strings?.[v[1]]!=='string')throw Error('bounded_inline_string_reference_invalid');
        return encoded.strings[v[1]];
      }
      if(v[0]!=='~')return v.map(expand);
      const keys=encoded.shapes[v[1]];
      if(!Number.isInteger(v[1])||!keys||v.length!==keys.length+2)throw Error('bounded_inline_record_reference_invalid');
      return Object.fromEntries(keys.map((key,i)=>[key,expand(v[i+2])]));
    }
    if(!v||typeof v!=='object')return v;
    if(v.encoding==='uniform-exact-pcm-starts-v1'){
      if(!Number.isFinite(v.first)||!Number.isFinite(v.step)||v.step<=0||!Number.isFinite(v.end)
        ||!Array.isArray(v.values)||v.values.some(row=>row.length!==2||row.some(x=>!Number.isFinite(x))))throw Error('bounded_inline_pcm_invalid');
      return {encoding:'adjacent-exact-pcm-intervals-v1',final_source_end_seconds:v.end,
        rows:v.values.map(([rms,peak],index)=>[v.first+index*v.step,rms,peak])};
    }
    return Object.fromEntries(Object.entries(v).map(([k,row])=>[k,expand(row)]));
  }
  return expand(encoded.value);
}
