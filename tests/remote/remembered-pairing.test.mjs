import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createDeviceStore} from '../../packages/desktop/src/remote/device-store.mjs';
import {RemoteCore} from '../../packages/desktop/src/remote/remote-core.mjs';
import {PairingApproval} from '../../packages/desktop/src/remote/pairing.mjs';
import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';
const token='SYNTHETIC-REMEMBERED-PHONE-ONLY-'.repeat(3);
function fixture(){const folder=fs.mkdtempSync(path.join(os.tmpdir(),'flyx-remembered-'));fs.chmodSync(folder,0o700);const id='fixture-phone-001',now=100000;
 fs.writeFileSync(path.join(folder,'devices.json'),JSON.stringify({version:1,devices:[],pending:[{id,name:'Synthetic phone',digest:crypto.createHash('sha256').update(token).digest('hex'),expires:now+3600000}]}),{mode:0o600});
 const store=createDeviceStore(folder,()=>now);const makeCore=()=>new RemoteCore({now:()=>now,loadDevices:store.loadDevices,saveDevices:store.saveDevices,dispatch:async()=>({ok:true})});return{folder,id,store,makeCore,cleanup:()=>fs.rmSync(folder,{recursive:true,force:true})};}
test('prepared phone remains unauthorized until its explicit local Mac approval; no plaintext token reaches disk',async()=>{const f=fixture();try{const core=f.makeCore(),pairing=new PairingApproval({core,enrollmentStore:f.store,now:()=>100000});const handle=createRemoteHandler({core,pairing,pendingSession:t=>f.store.pendingToken(t)});
 const request=t=>handle({method:'GET',path:'/remote/v1/session',headers:{authorization:`Bearer ${t}`}});
 assert.equal((await request(token)).status,403);assert.equal((await request('unrecognized')).status,401);
 assert.equal(pairing.snapshot().pending.name,'Synthetic phone');assert.deepEqual(pairing.approve(f.id),{ok:true});assert.equal((await request(token)).status,200);
 assert.equal(fs.readFileSync(path.join(f.folder,'devices.json'),'utf8').includes(token),false);assert.equal(f.store.pending(),null);
 }finally{f.cleanup();}});
test('approved device survives Mac process recreation and shutdown memory cleanup; revocation persists',()=>{const f=fixture();try{const core=f.makeCore(),pairing=new PairingApproval({core,enrollmentStore:f.store,now:()=>100000});pairing.approve(f.id);core.clearMemory();assert.throws(()=>core.authorize(token,'catalog.read'));const restarted=f.makeCore();assert.equal(restarted.authorize(token,'catalog.read').name,'Synthetic phone');assert.throws(()=>restarted.authorize(token,'downloads.write'));restarted.revoke(f.id);assert.throws(()=>f.makeCore().authorize(token,'catalog.read'));}finally{f.cleanup();}});
test('rejecting a prepared phone removes pending access without granting a credential',()=>{const f=fixture();try{const core=f.makeCore(),pairing=new PairingApproval({core,enrollmentStore:f.store,now:()=>100000});pairing.reject(f.id);assert.equal(f.store.pendingToken(token),false);assert.throws(()=>core.authorize(token,'catalog.read'));assert.equal(f.store.loadDevices().length,0);}finally{f.cleanup();}});
test('remembered device store rejects insecure permissions and symlinked files',()=>{const f=fixture();try{const file=path.join(f.folder,'devices.json');fs.chmodSync(file,0o644);assert.throws(()=>f.store.loadDevices());fs.unlinkSync(file);fs.symlinkSync('/etc/hosts',file);assert.throws(()=>f.store.loadDevices());}finally{f.cleanup();}});

test('normal and prepared approvals remain paired across decades and restarts; revocation still persists',async()=>{
 for(const prepared of [false,true]){
  const f=fixture();let now=100000;
  try{
   const store=createDeviceStore(f.folder,()=>now);
   const makeCore=()=>new RemoteCore({now:()=>now,loadDevices:store.loadDevices,saveDevices:store.saveDevices,makeID:()=>f.id,makeToken:()=>token,dispatch:async()=>({ok:true})});
   const core=makeCore();
   const pairing=new PairingApproval({core,enrollmentStore:store,now:()=>now,makeSecret:()=>'a'.repeat(64),makeID:()=>f.id});
   if(prepared){pairing.approve(f.id);}else{
    store.clearPending();const offer=pairing.begin();const request=pairing.request({secret:offer.secret,name:'Synthetic phone'});
    pairing.approve(request.requestID);const grant=pairing.collect(request.requestID);assert.equal(grant.token,token);assert.equal(grant.expiresIn,0);
   }
   assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(path.join(f.folder,'devices.json'),'utf8'))).includes(token),false);
   core.clearMemory();now+=100*365*86400000;
   const restarted=makeCore();const handle=createRemoteHandler({core:restarted});
   const response=await handle({method:'GET',path:'/remote/v1/session',headers:{authorization:`Bearer ${token}`}});
   assert.equal(response.status,200);assert.equal(response.body.expiresAt,0);
   assert.throws(()=>restarted.authorize(token,'downloads.write'));
   restarted.revoke(f.id);assert.throws(()=>makeCore().authorize(token,'catalog.read'));
  }finally{f.cleanup();}
 }
});

test('existing approved pairings migrate without expiry, including old timed-out records; expired pending approval stays blocked',()=>{
 const f=fixture();try{
  const file=path.join(f.folder,'devices.json'),state=JSON.parse(fs.readFileSync(file,'utf8'));
  const existing=state.pending[0];state.pending=[{...existing,expires:99999}];
  state.devices=[{...existing,scopes:['catalog.read'],expires:99999},{...existing,id:'other-approved-phone',expires:200000,scopes:['catalog.read']}];
  fs.writeFileSync(file,JSON.stringify(state),{mode:0o600});
  assert.equal(f.store.pending(),null);assert.equal(f.store.pendingToken(token),false);
  assert.deepEqual(f.store.loadDevices().map(d=>d.expires),[0,0]);
  const migrated=JSON.parse(fs.readFileSync(file,'utf8'));
  assert.deepEqual(migrated.devices.map(d=>d.expires),[0,0]);assert.equal(migrated.pending[0].expires,99999);
  assert.equal(fs.statSync(file).mode&0o077,0);
  const core=f.makeCore();assert.equal(core.authorize(token,'catalog.read').name,'Synthetic phone');
  core.revokeAll();assert.equal(f.makeCore().listDevices().length,0);
 }finally{f.cleanup();}
});
