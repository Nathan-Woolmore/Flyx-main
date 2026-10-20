import test from 'node:test';import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createFileAccessBudget} from '../../packages/app/src/lib/downloads/file-access-budget.mjs';
import {sessionWithinBudget} from '../../packages/app/src/lib/auth/session-budget.mjs';
import {resolvePhoneSources} from '../../packages/app/src/lib/remote/source-resolution.mjs';
const fixture=fileURLToPath(new URL('./fixtures/worker-starvation79.mjs',import.meta.url));
test('real blocked filesystem workers reproduce auth failure; bounded file admission preserves signed phone preparation',()=>{
 const run=mode=>JSON.parse(execFileSync(process.execPath,[fixture,mode],{encoding:'utf8',timeout:8000,env:{...process.env,UV_THREADPOOL_SIZE:'4'}}).trim());
 const baseline=run('baseline');assert.equal(baseline.signatureVerified,false);assert.equal(baseline.errorCode,'PHONE_AUTH_TIMEOUT');assert.equal(baseline.grantCreated,false);assert.equal(baseline.opensBeforeRelease,5);
 const fixed=run('limited');assert.equal(fixed.signatureVerified,true);assert.equal(fixed.grantCreated,true);assert.equal(fixed.opensBeforeRelease,1);assert.equal(fixed.closedLate,1);assert.equal(fixed.desktopCalls,0);assert.equal(fixed.format,'hls');assert.equal(fixed.sourceSelection.contentID,38000);
});
test('timed-out callers do not release a blocked physical file operation; late handles close before new work',async()=>{
 const run=createFileAccessBudget({timeoutMS:15,maxQueued:2});let settle,started=0,closed=0;
 const held=run(()=>{started++;return new Promise(resolve=>settle=resolve);},async()=>closed++);
 const queued=run(async()=>{started++;return{};});assert.equal(await run(async()=>({})),null);assert.equal(await run(async()=>({})),null);
 assert.deepEqual(await Promise.all([held,queued]),[null,null]);assert.equal(started,1);
 assert.equal(await run(async()=>{started++;return{};}),null);assert.equal(started,1);
 settle({handle:'synthetic'});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,1);
 assert.deepEqual(await run(async()=>({ready:true})),{ready:true});
});
test('authentication budget fails closed for a stalled check and never accepts a late success',async()=>{
 let settle;await assert.rejects(sessionWithinBudget(()=>new Promise(resolve=>settle=resolve),{timeoutMS:10}),error=>error.code==='PHONE_AUTH_TIMEOUT');settle({isAdmin:true});
 assert.equal(await sessionWithinBudget(async()=>null),null);assert.deepEqual(await sessionWithinBudget(async()=>({isAdmin:false})),{isAdmin:false});
 const signal=AbortSignal.abort();let invoked=false;await assert.rejects(sessionWithinBudget(async()=>{invoked=true;return{};},{signal}));assert.equal(invoked,false);
});
test('auth timeout is not retried or mislabeled as a provider timeout',async()=>{
 const providers=[];await assert.rejects(resolvePhoneSources({kind:'anime',contentID:38000,season:1,episode:1},{fetcher:async url=>{providers.push(new URL(url,'http://fixture').searchParams.get('provider'));return Response.json({ok:false,code:'PHONE_AUTH_TIMEOUT'},{status:503});}}),error=>error.code==='PHONE_AUTH_TIMEOUT');assert.deepEqual(providers,['local']);
});
