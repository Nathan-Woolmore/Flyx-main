import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import {createHash, X509Certificate} from 'node:crypto';
import {createConnectionCode} from '../../packages/desktop/src/remote/connection-code.mjs';
import {inspectRemoteSetup, prepareRemoteSetup} from '../../packages/desktop/src/remote/setup.mjs';
import {loadRemoteConfiguration} from '../../packages/desktop/src/remote/configuration.mjs';
import {RemoteCore} from '../../packages/desktop/src/remote/remote-core.mjs';
import {PairingApproval} from '../../packages/desktop/src/remote/pairing.mjs';
import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';
import {installRemoteBridge} from '../../packages/desktop/src/remote/electron-bridge.mjs';
import {createSecureTransport, certificatePin} from '../../packages/desktop/src/remote/transport.mjs';
import {makeTestIdentity} from './test-identity.mjs';

const secret = 'a'.repeat(64), pin = 'b'.repeat(64);
test('one out-of-band code binds the full-strength secret, HTTPS name, pin and bounded expiry', () => {
  const code = createConnectionCode({endpoint:'https://synthetic.local:3892',pin,secret,expiresAt:121000},1000);
  const payload = JSON.parse(Buffer.from(code.slice(6),'base64url'));
  assert.deepEqual(payload,{v:1,endpoint:'https://synthetic.local:3892',pin,secret,expiresAt:121000});
  for (const endpoint of ['http://synthetic.local:3892','https://evil.example:3892','https://a.local:22','https://x:y@a.local:3892','https://a.local:3892/path']) {
    assert.throws(()=>createConnectionCode({endpoint,pin,secret,expiresAt:121000},1000));
  }
  for (const expiresAt of [1000,121001,Infinity]) assert.throws(()=>createConnectionCode({endpoint:'https://a.local:3892',pin,secret,expiresAt},1000));
  assert.throws(()=>createConnectionCode({endpoint:'https://a.local:3892',pin,secret:'123456',expiresAt:121000},1000));
});

test('wrong, expired and rate-limited codes fail closed; a valid code still needs explicit Mac approval', async () => {
  let now=1000, sequence=0;
  const core=new RemoteCore({now:()=>now,makeID:()=>`synthetic-device-${++sequence}`,makeToken:()=> 'SYNTHETIC-TOKEN-'.repeat(4),dispatch:()=>{throw new Error('No playback in pairing tests');}});
  const pairing=new PairingApproval({core,now:()=>now,makeID:()=>`synthetic-request-${++sequence}`,makeSecret:()=>secret});
  const handle=createRemoteHandler({core,pairing});
  pairing.begin();
  const request=body=>handle({method:'POST',path:'/remote/v1/pair/request',body});
  assert.equal((await request({secret:'0'.repeat(64),name:'Synthetic iPhone'})).body.code,'PAIRING_CODE_REJECTED');
  for(let i=0;i<4;i++)await request({secret:'0'.repeat(64),name:'Synthetic iPhone'});
  assert.equal((await request({secret,name:'Synthetic iPhone'})).status,429);
  pairing.begin();
  const pending=await request({secret,name:'Synthetic iPhone'});
  assert.equal(pending.status,202);
  assert.equal(pairing.collect(pending.body.requestID).token,undefined);
  assert.equal(core.listDevices().length,0);
  pairing.approve(pending.body.requestID);
  const granted=pairing.collect(pending.body.requestID);
  assert.ok(granted.token);assert.equal(core.listDevices().length,1);
  pairing.begin();now+=120000;
  assert.equal((await request({secret,name:'Synthetic iPhone'})).body.code,'PAIRING_CODE_EXPIRED');
  const info=await handle({method:'GET',path:'/remote/v1/info'});
  assert.equal(JSON.stringify(info).includes(secret),false);
});

test('creating/copying a code is local-frame-only and cancellation retains remembered phones', async () => {
  const {cert,key}=makeTestIdentity(),handlers=new Map();let copied;
  const digest=createHash('sha256').update('SYNTHETIC-REMEMBERED-'.repeat(3)).digest('hex');
  const bridge=installRemoteBridge({handleTrusted:(name,fn)=>handlers.set(name,fn),isMainFrame:event=>event.trusted===true,
    copyText:value=>copied=value,send:()=>{},tlsProvider:async()=>({cert,key,port:0}),transportEndpoint:'https://synthetic.local:3892',
    deviceStore:{loadDevices:()=>[{id:'remembered-device',name:'Existing synthetic phone',digest,scopes:['catalog.read'],expires:Date.now()+60000}],saveDevices:()=>{},pending:()=>null}});
  try {
    assert.throws(()=>handlers.get('flyx:remote-connection-code')({trusted:false}));
    assert.throws(()=>handlers.get('flyx:remote-connection-code')({trusted:true}));
    await handlers.get('flyx:remote-transport-start')({trusted:true});
    const offer=handlers.get('flyx:remote-connection-code')({trusted:true});
    handlers.get('flyx:remote-copy-code')({trusted:true});assert.equal(copied,offer.code);
    handlers.get('flyx:remote-pair-cancel')({trusted:true});
    assert.throws(()=>handlers.get('flyx:remote-copy-code')({trusted:true}));
    assert.equal(handlers.get('flyx:remote-approval-state')({trusted:true}).devices.length,1);
  } finally {await bridge.dispose();}
});

test('phone cancellation requires its offer secret and cannot revoke a previously remembered device', () => {
  let count=0;
  const rememberedToken='SYNTHETIC-REMEMBERED-'.repeat(3);
  const core=new RemoteCore({makeID:()=>`synthetic-${++count}`,makeToken:()=> 'SYNTHETIC-NEW-TOKEN-'.repeat(3),dispatch:()=>{},loadDevices:()=>[{id:'old-device',name:'Old phone',scopes:['catalog.read'],digest:createHash('sha256').update(rememberedToken).digest('hex'),expires:Date.now()+60000}]});
  const pairing=new PairingApproval({core,makeSecret:()=>secret,makeID:()=>`synthetic-request-${++count}`});
  pairing.begin();const first=pairing.request({secret,name:'New phone'});
  assert.throws(()=>pairing.cancelRequest({requestID:first.requestID,secret:'0'.repeat(64)}));
  pairing.cancelRequest({requestID:first.requestID,secret});assert.equal(pairing.snapshot().pending,null);
  const retry=pairing.request({secret,name:'Retry phone'});pairing.approve(retry.requestID);
  assert.equal(core.listDevices().length,2);
  pairing.cancelRequest({requestID:retry.requestID,secret});assert.deepEqual(core.listDevices().map(x=>x.id),['old-device']);
  pairing.begin();const late=pairing.request({secret,name:'Cancelled during collection'});pairing.approve(late.requestID);
  assert.ok(pairing.collect(late.requestID).token);
  assert.throws(()=>pairing.collect(late.requestID));
  pairing.cancelRequest({requestID:late.requestID,secret});assert.deepEqual(core.listDevices().map(x=>x.id),['old-device']);
  assert.equal(core.authorize(rememberedToken,'catalog.read').id,'old-device');
});

function fixture() {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'flyx-setup81-'));fs.chmodSync(dataDir,0o700);
  return {dataDir,folder:path.join(dataDir,'remote'),cleanup:()=>fs.rmSync(dataDir,{recursive:true,force:true})};
}
function existing(f) {
  const {cert,key}=makeTestIdentity();fs.mkdirSync(f.folder,{mode:0o700});
  const certFile=path.join(f.folder,'original-cert.pem'),keyFile=path.join(f.folder,'original-key.pem');
  fs.writeFileSync(certFile,cert,{mode:0o600});fs.writeFileSync(keyFile,key,{mode:0o600});
  const config={host:'synthetic.local',bindAddress:'192.168.1.7',port:3892,certFile,keyFile,enabled:true};
  fs.writeFileSync(path.join(f.folder,'config.json'),JSON.stringify(config),{mode:0o600});
  fs.writeFileSync(path.join(f.folder,'devices.json'),'SYNTHETIC ENROLLMENT BYTES',{mode:0o600});
  for(const name of ['.env','store.json','downloads.json'])fs.writeFileSync(path.join(f.dataDir,name),'SYNTHETIC DATA '+name,{mode:0o600});
  return config;
}
function preserved(f,config) {
  return [config.certFile,config.keyFile,path.join(f.folder,'devices.json'),...['.env','store.json','downloads.json'].map(n=>path.join(f.dataDir,n))]
    .map(file=>[file,fs.readFileSync(file)]);
}

test('setup cancellation performs no filesystem or identity mutation', async () => {
  const f=fixture();let generated=false;
  try {
    const result=await prepareRemoteSetup({dataDir:f.dataDir,host:'new-mac.local',addresses:['192.168.1.9'],confirm:async()=>false,generate:()=>generated=true});
    assert.equal(result.cancelled,true);assert.equal(generated,false);assert.equal(fs.existsSync(f.folder),false);
  }finally{f.cleanup();}
});

test('old hostname migration uses the new Mac name after confirmation, preserving every existing identity and data record', async () => {
  const f=fixture();
  try {
    const config=existing(f),saved=preserved(f,config);let reviewed;
    const options={dataDir:f.dataDir,host:'new-mac.local',addresses:['192.168.1.9']};
    assert.equal(inspectRemoteSetup(options).status,'moved');
    const result=await prepareRemoteSetup({...options,confirm:async plan=>(reviewed=plan,true)});
    assert.equal(reviewed.replaceIdentity,true);assert.equal(result.restartRequired,true);
    const loaded=loadRemoteConfiguration({dataDir:f.dataDir,addresses:['192.168.1.9']});
    assert.equal(loaded.host,'new-mac.local');assert.equal(loaded.enabled,true);
    const material=await loaded.tlsProvider();assert.ok(new X509Certificate(material.cert).checkHost('new-mac.local'));
    assert.equal(new X509Certificate(material.cert).checkHost('synthetic.local'),undefined);
    for(const[file,bytes]of saved)assert.deepEqual(fs.readFileSync(file),bytes);
    const next=JSON.parse(fs.readFileSync(path.join(f.folder,'config.json')));
    for(const file of [next.certFile,next.keyFile,path.join(f.folder,'config.json')])assert.equal(fs.statSync(file).mode&0o777,0o600);
  }finally{f.cleanup();}
});

test('DHCP rediscovery keeps the certificate and enrollment when the Mac name is unchanged', async () => {
  const f=fixture();
  try {
    const config=existing(f),saved=preserved(f,config);const options={dataDir:f.dataDir,host:'synthetic.local',addresses:['192.168.1.10']};
    assert.equal(inspectRemoteSetup(options).status,'network-changed');
    await prepareRemoteSetup({...options,confirm:async()=>true,generate:()=>{throw new Error('Must not rotate identity for DHCP');}});
    const next=JSON.parse(fs.readFileSync(path.join(f.folder,'config.json')));
    assert.equal(next.bindAddress,'192.168.1.10');assert.equal(next.certFile,config.certFile);assert.equal(next.keyFile,config.keyFile);
    for(const[file,bytes]of saved)assert.deepEqual(fs.readFileSync(file),bytes);
  }finally{f.cleanup();}
});

test('setup refuses unsafe folders and changed review state; failed generation leaves old configuration intact', async () => {
  const f=fixture();
  try {
    existing(f);const file=path.join(f.folder,'config.json'),before=fs.readFileSync(file);
    const options={dataDir:f.dataDir,host:'new-mac.local',addresses:['192.168.1.9']};
    await assert.rejects(prepareRemoteSetup({...options,confirm:async()=>true,generate:()=>{throw new Error('Synthetic generation failure');}}));
    assert.deepEqual(fs.readFileSync(file),before);
    assert.equal(fs.readdirSync(f.folder).some(name=>name.startsWith('.identity-')),false);
    fs.chmodSync(f.folder,0o755);assert.throws(()=>inspectRemoteSetup(options));
    fs.chmodSync(f.folder,0o700);
    await assert.rejects(prepareRemoteSetup({...options,confirm:async()=>{fs.writeFileSync(file,before+' ');return true;}}),/changed/);
  }finally{f.cleanup();}
});

test('provisioned TLS enforces trusted leaf, hostname and pin without changing a trust store', async () => {
  const f=fixture();let transport;
  try {
    await prepareRemoteSetup({dataDir:f.dataDir,host:'new-mac.local',addresses:['192.168.1.9'],confirm:async()=>true});
    const config=loadRemoteConfiguration({dataDir:f.dataDir,addresses:['192.168.1.9']}),material=await config.tlsProvider();
    let requests=0;transport=createSecureTransport({...material,port:0,host:'127.0.0.1',allowedHosts:['new-mac.local'],handle:async()=>{requests++;return{status:200,body:{ok:true}};}});
    const {port}=await transport.start();
    function get(host='new-mac.local',pin=certificatePin(material.cert)) {
      return new Promise((resolve,reject)=>{
        const request=https.get({host:'127.0.0.1',port,servername:host,ca:material.cert,agent:false,headers:{host:'new-mac.local'},checkServerIdentity:(name,cert)=>tls.checkServerIdentity(name,cert)??(cert.fingerprint256.replaceAll(':','').toLowerCase()===pin?undefined:new Error('Pin mismatch'))},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
        request.on('error',reject);
      });
    }
    assert.equal(await get(),200);
    await assert.rejects(get('wrong-mac.local'));
    await assert.rejects(get('new-mac.local','0'.repeat(64)),/Pin mismatch/);
    assert.equal(requests,1);
  }finally{await transport?.stop();f.cleanup();}
});
