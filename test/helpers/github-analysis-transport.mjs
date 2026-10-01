// Test-only preload: no application hook or real GitHub credentials are used.
import {createHash} from 'node:crypto';
import {appendFile,readFile} from 'node:fs/promises';
if(process.env.TEST_REPOSITORY_ANALYSIS_FIXTURE!=='1')throw Error('Fixture requires its isolated test environment.');
const originalFetch=globalThis.fetch;
const sha=value=>createHash('sha1').update(value).digest('hex');
const repos=['studio/alpha','studio/beta'];
const fixtures=repos.map(repository=>{
  const files=[['README.md',`# ${repository}\nA proprietary planning product.\nREPOSITORY_EVIDENCE_${repository.split('/')[1].toUpperCase()}\nThis description alone is not proof of adoption.\n`],['package.json','{"name":"sample-product","scripts":{"test":"node --test"},"dependencies":{"example":"1.0.0"}}\n'],['src/index.ts','export function plan(items: string[]) { return items.map(item => ({title: item, status: "draft"})); }\n']].map(([path,text])=>({path,text,sha:sha(`blob ${Buffer.byteLength(text)}\0${text}`),size:Buffer.byteLength(text),type:'blob',mode:'100644'}));
  return {repository,commit:sha(repository+'commit'),tree:sha(repository+'tree'),subtree:sha(repository+'subtree'),files};
});
globalThis.fetch=async(input,options={})=>{
  const url=new URL(String(input));
  if(url.origin!=='https://api.github.com')return originalFetch(input,options);
  await appendFile(process.env.TEST_GITHUB_LOG,JSON.stringify({method:options.method||'GET',path:url.pathname,query:url.search})+'\n');
  if(options.method&&options.method!=='GET')throw Error('Fixture forbids GitHub writes.');
  const control=await readFile(process.env.TEST_ANALYSIS_CONTROL,'utf8').then(JSON.parse).catch(()=>({}));
  if(control.delayGitHub)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,5000);const stop=()=>{clearTimeout(timer);reject(new Error('Aborted'));};if(options.signal?.aborted)stop();else options.signal?.addEventListener('abort',stop,{once:true});});
  const f=fixtures.find(item=>url.pathname===`/repos/${item.repository}`||url.pathname.startsWith(`/repos/${item.repository}/`));
  if(!f)return Response.json({message:'not found'},{status:404});
  const path=url.pathname.slice(`/repos/${f.repository}`.length);
  if(!path)return Response.json({full_name:f.repository,private:true,default_branch:'main',archived:false});
  if(path.startsWith('/commits/'))return Response.json({sha:f.commit});
  if(path===`/git/commits/${f.commit}`)return Response.json({sha:f.commit,tree:{sha:f.tree},parents:[]});
  if(path===`/git/trees/${f.tree}`){
    const entries=f.files.filter(item=>!item.path.includes('/')).map(({text,...item})=>item);
    entries.push({path:'src',type:'tree',mode:'040000',sha:f.subtree});
    if(url.searchParams.get('recursive')==='1')entries.push(...f.files.filter(item=>item.path.includes('/')).map(({text,...item})=>item));
    return Response.json({sha:f.tree,truncated:false,tree:entries});
  }
  if(path===`/git/trees/${f.subtree}`)return Response.json({sha:f.subtree,truncated:false,tree:f.files.filter(item=>item.path.startsWith('src/')).map(({text,...item})=>({...item,path:item.path.slice(4)}))});
  if(path.startsWith('/git/blobs/')){
    const file=f.files.find(item=>path===`/git/blobs/${item.sha}`);
    if(file)return Response.json({sha:file.sha,size:file.size,encoding:'base64',content:Buffer.from(file.text).toString('base64')});
  }
  return Response.json({message:'unexpected fixture path'},{status:404});
};
