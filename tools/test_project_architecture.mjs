// Offline integration checks: real Pi extension loader + fake child CLI.
// No provider client, model API, Telegram bridge or remote host is invoked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

if (process.argv.includes('--mode')) {
  const args=process.argv.slice(2), task=args.at(-1);
  for(const flag of ['--no-extensions','--no-mcp','--no-approve']) assert(args.includes(flag),flag);
  assert(!args.includes('--api-key'));
  const fork=args.includes('--session');
  let snapshot;
  if(fork){snapshot=args[args.indexOf('--session')+1];assert.equal(fs.statSync(snapshot).mode&0o777,0o600);assert(fs.readFileSync(snapshot,'utf8').includes('parent-marker'));}
  else assert(args.includes('--no-session'));
  if(task.includes('EMPTY'))process.exit(0);
  const usage={input:7,output:3,cacheRead:0,cacheWrite:0,totalTokens:10,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
  const message={role:'assistant',content:[{type:'text',text:JSON.stringify({fork,snapshot,cwd:process.cwd()})}],provider:'fixture',model:'fixture',api:'openai-responses',usage,stopReason:task.includes('FAIL')?'error':'stop',timestamp:0};
  console.log(JSON.stringify({type:'message_end',message}));
  console.log(JSON.stringify({type:'agent_end',messages:[message],willRetry:false}));
  if(task.includes('DELAY'))await new Promise(r=>setTimeout(r,800));
  console.log(JSON.stringify({type:'agent_settled'}));
  process.exit(0);
}

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=fs.readFileSync(path.join(os.homedir(),'.pi/agent/install/current-version'),'utf8').trim();
const host=path.join(os.homedir(),'.pi/agent/install/releases',version,'node_modules/@earendil-works/pi-coding-agent');
const {loadExtensions}=await import(pathToFileURL(path.join(host,'dist/core/extensions/loader.js')));
const names=['pi-fork/src/index.ts','pi-minimal-subagent/index.ts','pi-observational-memory/src/index.ts','pi-usage-log/index.ts'];
const loaded=await loadExtensions(names.map(n=>path.join(root,'packages',n)),root);
assert.deepEqual(loaded.errors,[]);
const definitions=loaded.extensions.flatMap(e=>[...e.tools.values()].map(t=>t.definition));
assert.deepEqual(definitions.map(t=>t.name),['fork','subagent','recall']);
assert(loaded.extensions[3].handlers.has('turn_end'),'usage-log turn_end handler');
assert([...loaded.extensions[3].commands.keys()].includes('usage'),'usage command');
const fork=definitions[0],subagent=definitions[1];
const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'pi-project-check-'));
try {
 fs.mkdirSync(path.join(cwd,'.pi'));
 fs.writeFileSync(path.join(cwd,'.pi/settings.json'),JSON.stringify({'pi-fork':{extensions:[]}}));
 const ctx={cwd,hasUI:false,isProjectTrusted:()=>true,modelRegistry:{find:()=>undefined},sessionManager:{getHeader:()=>({type:'session',id:'parent-marker',cwd}),getBranch:()=>[]}};
 const invoke=(tool,task,extra={})=>tool.execute('fixture-call',tool===fork?{task,...extra}:{prompt:task,tools:['read'],...extra},undefined,undefined,ctx);
 for(const tool of [fork,subagent]) {
   const ok=await invoke(tool,'OK');assert(!ok.isError);const data=JSON.parse(ok.content[0].text);assert.equal(data.fork,tool===fork);assert.equal(data.cwd,fs.realpathSync(cwd));
   if(data.snapshot)assert(!fs.existsSync(data.snapshot),'fork snapshot cleaned');
   assert.equal((await invoke(tool,'FAIL')).isError,true,'API-style error is not success');
   assert.equal((await invoke(tool,'EMPTY')).isError,true,'empty output is not success');
 }
 const started=Date.now();await invoke(fork,'DELAY');assert(Date.now()-started>=700,'must wait for agent_settled, not agent_end');
 await assert.rejects(invoke(subagent,'OK',{cwd:'..'}),/inside the dispatching project/);
 await assert.rejects(invoke(subagent,'OK',{tools:['telegram_message']}),/built-in child tools/);
 assert(loaded.extensions[2].handlers.has('session_shutdown'));
 assert(loaded.extensions[2].handlers.has('session_tree'));
 const compact=loaded.extensions[2].handlers.get('session_before_compact')[0];
 const partial=[{type:'message',id:'old-1'},{type:'message',id:'old-2'},
  {type:'custom',id:'memory',customType:'om.observations.recorded',data:{coversUpToId:'old-1',observations:[{}]}},
  {type:'message',id:'kept'}];
 assert.equal(await compact({branchEntries:partial,preparation:{firstKeptEntryId:'kept',tokensBefore:100}},ctx),undefined,'unobserved span must use native compaction');
 console.log(JSON.stringify({status:'PASS',pi:version,model_api_calls:0,checks:['three extensions load','fork branch snapshot/private cleanup','independent context','child flags','error and empty result','settled boundary','project cwd','child tool allowlist','memory lifecycle hooks','partial-memory compaction fallback','usage-log extension']}));
} finally {fs.rmSync(cwd,{recursive:true,force:true});}
