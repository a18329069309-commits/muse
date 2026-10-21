import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdir,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = path.join(root,'.muse','test-temp');
await mkdir(temporary,{recursive:true});
const environment = {...process.env,TMP:temporary,TEMP:temporary,TMPDIR:temporary,PYTHONDONTWRITEBYTECODE:'1'};
for (const key of Object.keys(environment)) {
  if (/^(?:NODE_OPTIONS|FFREPORT|REPORT|AV_LOG_FORCE_COLOR)$/i.test(key)
    || /^(?:SDR_|OPENAI_|ANTHROPIC_|GEMINI_)/i.test(key)
    ||/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY|PASSWORD)$/i.test(key)) delete environment[key];
}
const tests = ['test_episode_task_queue.mjs','test_sound_arc_plan.mjs','test_render_audio.mjs',
  'test_music_edit_operation_contract.mjs','test_sound_edit_decision_contract.mjs','test_prepare_episode.mjs',
  'test_doctor.mjs','test_demo_offline.mjs'];
const start=Date.now();let output='';
const child = spawn(process.execPath,['--import',pathToFileURL(path.join(root,'tools/no-network.mjs')).href,
  '--test','--test-reporter=tap','--test-concurrency=1',...tests.map(file=>path.join(root,'tests',file))],
  {cwd:root,env:environment,stdio:['ignore','pipe','pipe'],windowsHide:true,shell:false});
child.stdout.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
child.stderr.on('data',chunk=>{output+=chunk;process.stderr.write(chunk);});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('close',async code=>{
  process.exitCode=code??1;
  const count=kind=>Number(output.match(new RegExp('^# '+kind+' (\\d+)$','m'))?.[1]??0);
  try{
    await writeFile(path.join(root,'.muse','offline-test.log'),output);
    await writeFile(path.join(root,'.muse','offline-result.json'),JSON.stringify({
      date:new Date().toISOString(),node:process.version,platform:process.platform,
      exit_code:code,elapsed_ms:Date.now()-start,tests:count('tests'),pass:count('pass'),
      fail:count('fail'),skipped:count('skipped'),scope:'synthetic offline engineering tests, no artistic approval',
      files:tests},null,2)+'\n');
  }catch(error){console.error(error.message);process.exitCode=1;}
});
