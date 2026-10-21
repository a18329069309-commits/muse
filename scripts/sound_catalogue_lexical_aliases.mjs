import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,verifyEvidenceBindings,shaBytes} from './audio_api.mjs';
import {hashFile} from './render_binding.mjs';

const run=promisify(execFile),implementation=fileURLToPath(import.meta.url);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
// These are bilingual dictionary entries for finding publisher labels. They do
// not label a recording, infer a heard event, or approve its narrative purpose.
const groups=[
  ['impact',['impact','hit','strike','slam','thud','punch','smack','collision','knock','crash'],['撞击','碰撞','冲击','打击','击中','重击','砰','敲击','巴掌']],
  ['sting',['sting','stinger','accent'],['惊爆','爆点','重音','冲击','震撼']],
  ['tension',['suspense','tension','horror','scary','ominous'],['紧张','悬疑','惊悚','恐怖','诡异','惊爆']],
  ['whoosh',['whoosh','swish','swoosh','sweep','swipe'],['呼啸','挥舞','挥动','嗖']],
  ['transition',['transition'],['转场']],
  ['riser',['riser','rise','swell','build','build-up'],['上升','升起','渐强','蓄势','倒计时']],
  ['low',['bass','rumble','drone'],['低音','低频','轰鸣']],
  ['pulse',['pulse'],['脉冲','节拍','心跳']],
  ['heartbeat',['heartbeat','heart-beat'],['心跳','心脏']],
  ['information',['reveal','notification','alert','information','popup','pop-up','interface'],['提示','信息','出现','弹出','系统','界面']],
  ['digital',['digital','electronic','computer','scifi','sci-fi'],['电子','电流','系统','科技','科幻']],
  ['magic',['magic','magical','spell'],['魔法','法术','玄幻']],
  ['comedy',['comic','comedy','funny','cartoon'],['搞笑','滑稽','卡通','欢快']],
  ['explosion',['explosion','explosive','blast','boom'],['爆炸','炸弹','引爆','轰隆']],
  ['breath',['breath','breathing','gasp'],['呼吸','喘气','叹气']],
  ['rain',['rain','rainfall'],['雨声','下雨','雷雨']],
  ['wind',['wind','gust'],['风声','大风','刮风']],
  ['water',['water','stream','river'],['流水','水流','河流','水声']],
  ['crowd',['crowd','crowds','murmur'],['人群','议论','窃语','欢呼']],
];
const negative=/不要|避免|不需要|不是|不用|\b(?:without|not|no)\b/i;
const englishMatch=(value,word)=>new RegExp('(?:^|[^a-z0-9])'+word.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'(?:$|[^a-z0-9])','i').test(value);

export function soundCatalogueDictionaryAliases(value){
  if(typeof value!=='string'||negative.test(value))return {groups:[],aliases:[]};
  const matched=groups.filter(([,en,zh])=>en.some(term=>englishMatch(value,term))||zh.some(term=>value.includes(term)));
  return {groups:matched.map(([id])=>id),aliases:[...new Set(matched.flatMap(([,en,zh])=>[...en,...zh]))]};
}

// Bind the host's lexical translation to the unchanged positive query and the
// real frozen metadata inventory. Existing exact filters are reapplied by the
// same query_library consumer before its normal 20-candidate limit.
export async function resolveSoundCatalogueLexicalAliases({projected,query,libraryBinding,directorBinding,python='python'}){
  if(!projected?.ready||!libraryBinding||!['sfx','ambience'].includes(projected.retrieval?.asset_kind))return projected;
  const positive=projected.retrieval.text,dictionary=soundCatalogueDictionaryAliases(positive);
  if(!dictionary.aliases.length)return projected;
  await verifyEvidenceBindings([libraryBinding,directorBinding]);
  if(directorBinding){
    const encoded=await readJson(directorBinding.path),director=encoded.direction??encoded;
    if(!same(director.sound_queries?.find(row=>row.event_id===query?.event_id),query))
      throw Error('sound_catalogue_alias_bound_director_query_mismatch');
  }
  const helper=path.join(path.dirname(implementation),'sound_catalogue_lexical_aliases.py'),
    helperBinding={path:helper,sha256:await hashFile(helper)};
  const {stdout}=await run(python,['-X','utf8',helper,'--library',libraryBinding.path,'--query',
    JSON.stringify(projected.retrieval),'--aliases',JSON.stringify(dictionary.aliases)],
    {windowsHide:true,encoding:'utf8',maxBuffer:4*1024*1024});
  const result=JSON.parse(stdout);
  if(result.kind!=='bounded_sound_catalogue_metadata_aliases'||!Array.isArray(result.candidate_ids)
    ||result.candidate_ids.length>100||result.actual_audio_read!==false||result.qualification_granted!==false)
    throw Error('sound_catalogue_alias_inventory_result_invalid');
  await verifyEvidenceBindings([libraryBinding,directorBinding,helperBinding]);
  const audit={schema_version:1,library:libraryBinding,dictionary_revision:shaBytes(JSON.stringify(groups)),
    implementation:{path:implementation,sha256:await hashFile(implementation)},metadata_helper:helperBinding,
    original_positive_query:positive,original_intent:projected.original_intent,
    dictionary_groups:dictionary.groups,metadata_aliases:dictionary.aliases,
    original_candidate_count:result.original_candidate_count,alias_candidate_count:result.alias_candidate_count,
    additional_candidate_count:result.additional_candidate_count,
    match_evidence:result.matches,scope:'publisher_title_directory_lexical_candidates_not_heard_sound_or_use',
    action:result.additional_candidate_count?'bounded_metadata_alias_candidate_union':'original_query_preserved',
    original_filters_preserved:true,qualification_granted:false,actual_audio_read:false};
  if(!result.additional_candidate_count)return {...projected,catalogue_lexical_aliases:audit};
  return {...projected,retrieval:{...projected.retrieval,text:'',candidate_segment_ids:result.candidate_ids},
    catalogue_lexical_aliases:audit};
}
