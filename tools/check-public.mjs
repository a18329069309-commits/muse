import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,readdir,lstat} from 'node:fs/promises';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const issues=[];let checked=0;
const rules=[
  ['private-key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token',/\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ['github-fine-grained-token',/\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['provider-secret',/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/],
  ['private-machine-path',/[A-Z]:[\\/](?:Users[\\/][^\s'"/\\]+[\\/]|AI-Data[\\/](?:SDR|AudioTrials|RelocatedUserData)[\\/])/i],
];
async function walk(directory){
 for(const entry of await readdir(directory,{withFileTypes:true})){
  if(['.git','.muse','node_modules'].includes(entry.name))continue;
  const file=path.join(directory,entry.name),relative=path.relative(root,file).replaceAll('\\','/');
  if((await lstat(file)).isSymbolicLink()){issues.push({file:relative,rule:'symlink'});continue;}
  if(entry.isDirectory()){await walk(file);continue;}
  if(/\.(?:mp4|mov|mp3|wav|flac|sqlite\d?|db|pklz?|pt|pth|safetensors|exe|dll|pyc|zip)$/i.test(entry.name)
    ||entry.name.startsWith('.env')){issues.push({file:relative,rule:'private-or-binary-artifact'});continue;}
  const bytes=await readFile(file);checked++;
  if(bytes.includes(0)){issues.push({file:relative,rule:'unexpected-binary'});continue;}
  const text=bytes.toString('utf8');
  // JSON and embedded command examples can escape each Windows separator twice.
  const pathText=text.replace(/\\{2,}/g,'\\');
  for(const[name,pattern]of rules)if(pattern.test(name==='private-machine-path'?pathText:text))issues.push({file:relative,rule:name});
  if(file.endsWith('.mjs'))for(const match of text.matchAll(/(['"])(\.{1,2}\/[^'"\r\n]+\.(?:mjs|js))\1/g)){
   const dependency=path.resolve(path.dirname(file),match[2]);
   if(dependency!==root&&!dependency.startsWith(root+path.sep)){issues.push({file:relative,rule:'module-outside-repository'});continue;}
   try{await lstat(dependency);}catch(error){if(error.code==='ENOENT')issues.push({file:relative,rule:'missing-module',dependency:match[2]});else throw error;}
  }
 }
}
await walk(root);
console.log(JSON.stringify({scope:'static public-file and relative-JS-dependency checks; not a complete secret/security audit',checked,issues},null,2));
if(issues.length)process.exitCode=1;
