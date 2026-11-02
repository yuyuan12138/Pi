// Offline unit tests for packages/pi-delegation-gate.
// Real loadExtensions loader + fake contexts. No model calls, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const version=fs.readFileSync(path.join(os.homedir(),'.pi/agent/install/current-version'),'utf8').trim();
const host=path.join(os.homedir(),'.pi/agent/install/releases',version,'node_modules/@earendil-works/pi-coding-agent');
const {loadExtensions}=await import(pathToFileURL(path.join(host,'dist/core/extensions/loader.js')));

// Simulate the parent session: subagent extension self-disables under this flag.
delete process.env.PI_SUBAGENT_CHILD;
const names=['pi-fork/src/index.ts','pi-minimal-subagent/index.ts','pi-delegation-gate/index.ts'];
const loaded=await loadExtensions(names.map(n=>path.join(root,'packages',n)),root);
assert.deepEqual(loaded.errors,[]);

// Locate the gate's tool_call handler.
const gateExt=loaded.extensions.find(e=>e.handlers.has('tool_call')&&[...e.tools.values()].length===0);
assert(gateExt,'gate extension with tool_call handler loaded');
const handler=gateExt.handlers.get('tool_call').at(-1); // last registered wins (gate loads after fork)
const ctx={cwd:root,hasUI:false,isProjectTrusted:()=>true,mode:'json'};

// Redirect the delegation log.
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'pi-gate-'));
process.env.PI_DELEGATION_GATE_LOG=path.join(tmp,'delegation.jsonl');
// re-import a fresh copy so the env override is read per call (function reads env at call time)
const forkEvent=(input)=>({type:'tool_call',toolName:'fork',toolCallId:'call-'+Math.random().toString(36).slice(2),input});

try {
 // 1. Fork without justification -> blocked with guidance.
 const blocked=await handler(forkEvent({task:'Fix the bug in src/foo.ts'}),ctx);
 assert.equal(blocked.block,true,'unjustified fork must be blocked');
 assert.match(blocked.reason,/fork-context/,'reason must name the required marker');
 assert.match(blocked.reason,/subagent/,'reason must point to subagent');
 assert(!fs.existsSync(process.env.PI_DELEGATION_GATE_LOG),'blocked fork must not log');

 // 2. Fork with marker -> allowed and logged with the declared reason.
 const allowed=await handler(forkEvent({task:'Continue the live debugging loop [fork-context: child must inspect the in-memory breakpoint state from this conversation]'}),ctx);
 assert.notEqual(allowed&&allowed.block,true,'justified fork must pass');
 const lines=fs.readFileSync(process.env.PI_DELEGATION_GATE_LOG,'utf8').trim().split('\n');
 assert.equal(lines.length,1,'one line per allowed fork');
 const entry=JSON.parse(lines[0]);
 assert.equal(entry.tool,'fork');
 assert.match(entry.reason,/breakpoint state/);
 assert.ok(entry.timestamp&&entry.toolCallId);

 // 3. Marker with empty reason is not a justification.
 const empty=await handler(forkEvent({task:'do stuff [fork-context:   ]'}),ctx);
 assert.equal(empty.block,true,'empty reason must block');

 // 4. Marker inside any string argument counts.
 const nested=await handler(forkEvent({task:'x',notes:'[fork-context: needs parent transcript ids]'}),ctx);
 assert.notEqual(nested&&nested.block,true,'marker in any string arg counts');

 // 5. Non-fork tools are untouched.
 const passthrough=await handler({type:'tool_call',toolName:'read',toolCallId:'c2',input:{path:'x'}},ctx);
 assert.equal(passthrough,undefined,'non-fork calls pass through');

 // 6. Existing extensions still load and expose their tools.
 const defs=loaded.extensions.flatMap(e=>[...e.tools.values()].map(t=>t.definition.name)).sort();
 assert.deepEqual(defs,['fork','subagent']);
 console.log(JSON.stringify({status:'PASS',pi:version,checks:['unjustified fork blocked','justified fork allowed+logged','empty reason blocked','marker in any arg','non-fork passthrough','coexistence with fork/subagent']}));
} finally {delete process.env.PI_DELEGATION_GATE_LOG;fs.rmSync(tmp,{recursive:true,force:true});}
