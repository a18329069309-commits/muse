import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson, verifyEvidenceBindings, shaBytes} from './audio_api.mjs';

const run=promisify(execFile), catalogs=new Map();
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const catalogCode=`import json,sqlite3,sys
from pathlib import Path
db=sqlite3.connect(Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
try:
 print(json.dumps([r[0] for r in db.execute('SELECT DISTINCT function FROM functions ORDER BY function')],ensure_ascii=False))
finally:
 db.close()
`;

// functions.function is an exact catalogue identifier, not free-form scene intent.
// Only a hash-bound model query can have an invented ID removed. Caller filters,
// exclusions and source/duration constraints retain their original strict meaning.
export async function resolveSoundCatalogFunction({projected,query,libraryBinding,directorBinding,
  python='python',hardFunctionConstraint=false}){
  if(!projected?.ready||!libraryBinding||!projected.retrieval?.function)return projected;
  await verifyEvidenceBindings(libraryBinding);
  const key=JSON.stringify([path.resolve(libraryBinding.path),libraryBinding.sha256,python]);
  let functions=catalogs.get(key);
  if(!functions){
    const {stdout}=await run(python,['-X','utf8','-c',catalogCode,libraryBinding.path],
      {windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
    functions=JSON.parse(stdout);
    if(!Array.isArray(functions)||functions.some(value=>typeof value!=='string'))
      throw Error('sound_catalog_function_inventory_invalid');
    await verifyEvidenceBindings(libraryBinding);catalogs.set(key,functions);
  }
  const requested=projected.retrieval.function;
  const audit={schema_version:1,library:libraryBinding,requested_function:requested,
    catalog_inventory_sha256:shaBytes(JSON.stringify(functions)),catalog_function_count:functions.length,
    exact_catalog_match:functions.includes(requested),qualification_granted:false};
  if(audit.exact_catalog_match)return {...projected,catalog_function_resolution:{...audit,
    action:'retain_registered_exact_function'}};
  if(hardFunctionConstraint||!directorBinding||projected.projection_basis!=='explicit_director_fields')
    return {...projected,catalog_function_resolution:{...audit,action:'retain_external_or_hard_filter'}};
  await verifyEvidenceBindings(directorBinding);
  const encoded=await readJson(directorBinding.path),director=encoded.direction??encoded;
  const actual=director.sound_queries?.find(row=>row.event_id===query?.event_id);
  if(!actual||!same(actual,query))throw Error('sound_function_bound_director_query_mismatch');
  const retrieval=structuredClone(projected.retrieval);delete retrieval.function;
  return {...projected,retrieval,catalog_function_resolution:{...audit,director:directorBinding,
    action:'model_purpose_preserved_as_intent_not_exact_catalog_identifier',
    original_intent:projected.original_intent,unregistered_semantic_function:requested,
    exact_filter_removed:true,source_and_duration_constraints_preserved:true,
    candidate_use_requires_original_intent_comparison:true}};
}
