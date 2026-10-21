import {makeTestIdentity} from './test-identity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {readFile} from 'node:fs/promises';
import {createSecureTransport,certificatePin} from '../../packages/desktop/src/remote/transport.mjs';
import {installRemoteBridge} from '../../packages/desktop/src/remote/electron-bridge.mjs';
import {nativeSwiftFixture} from './native-swift-fixture.mjs';
import {fileURLToPath} from 'node:url';
const {cert,key}=makeTestIdentity();
function send(port,{path='/remote/v1/info',method='GET',body,token,pin=certificatePin(cert),extraHeaders={}}={}) {
 return new Promise((resolve,reject)=>{
  const request=https.request({host:'127.0.0.1',port,servername:'synthetic.local',path,method,ca:cert,agent:false,checkServerIdentity:(host,peer)=>{const valid=peer.fingerprint256.replaceAll(':','').toLowerCase()===pin;return valid?undefined:new Error('Fixture certificate pin mismatch');},headers:{host:`127.0.0.1:${port}`,...(body?{'content-type':'application/json'}:{}),...(token?{authorization:`Bearer ${token}`} : {}),...extraHeaders}},response=>{let data='';response.on('data',chunk=>data+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(data),headers:response.headers}));});request.on('error',reject);request.end(body?JSON.stringify(body):undefined);
 });
}
test('fixture TLS transports local approval, catalog and acknowledged commands; wrong pin fails closed',async()=>{
 const handlers=new Map();let seq=0,playing=false;
 const bridge=installRemoteBridge({handleTrusted:(c,f)=>handlers.set(c,f),isMainFrame:()=>true,makeID:()=>`tls-fixture-${++seq}`,makeToken:()=> 'SYNTHETIC-TLS-ONLY-'.repeat(3),makeSecret:()=> 'b'.repeat(64),send:(_c,request)=>queueMicrotask(()=>handlers.get('flyx:remote-reply')({}, {requestID:request.requestID,ok:true,data:request.action==='catalog'?{data:[{id:7,title:'Synthetic TLS Movie'}]}:request.action==='command'?(playing=true,{ok:true,status:{state:'playing',position:0,duration:120}}):{state:playing?'playing':'paused',position:0,duration:120}}))});
 const transport=createSecureTransport({handle:bridge.handle,key,cert});
 try {
  const {port}=await transport.start();
  assert.equal((await send(port)).body.protocolVersion,1);
  await assert.rejects(send(port,{pin:'0'.repeat(64)}),/pin mismatch/);
  assert.equal((await send(port,{path:'/remote/v1/catalog?kind=movie'})).status,401);
  const offer=handlers.get('flyx:remote-pair-begin')({});
  const pending=await send(port,{method:'POST',path:'/remote/v1/pair/request',body:{secret:offer.secret,name:'TLS Fixture iPhone'}});
  assert.equal(pending.status,202);assert.equal(pending.body.token,undefined);
  handlers.get('flyx:remote-approve')({},{id:pending.body.requestID});
  const grant=await send(port,{method:'POST',path:'/remote/v1/pair/collect',body:{requestID:pending.body.requestID}});const token=grant.body.token;
  const catalog=await send(port,{path:'/remote/v1/catalog?kind=movie',token});assert.equal(catalog.body.items[0].title,'Synthetic TLS Movie');
  const command=await send(port,{method:'POST',path:'/remote/v1/commands',token,body:{id:'tls-play',type:'play',kind:'movie',contentID:7}});assert.equal(command.body.status.state,'playing');
  assert.equal((await send(port,{extraHeaders:{origin:'https://evil.invalid'}})).status,403);
  assert.equal((await send(port,{extraHeaders:{host:'evil.invalid'}})).status,403);
  assert.equal((await send(port,{method:'POST',body:{},extraHeaders:{'content-length':'20000'}})).status,413);
  assert.equal(catalog.headers['cache-control'],'no-store');
 }finally {await transport.stop();bridge.dispose();}
});

test('native URLSession performs pinned TLS handshake without modifying trust stores',{skip:process.platform!=='darwin'},async()=>{
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const transport=createSecureTransport({key,cert,handle:async()=>({status:200,body:{protocolVersion:1}})});
 const fixture=await nativeSwiftFixture([fileURLToPath(new URL('../../ios/Flyx Remote/App/PinnedSessionDelegate.swift',import.meta.url)),fileURLToPath(new URL('./fixtures/NativeTLS81.swift',import.meta.url))]);
 try{const {port}=await transport.start();const {stdout}=await promisify(execFile)(fixture.binary,[`https://127.0.0.1:${port}/remote/v1/info`,certificatePin(cert)],{timeout:15000});assert.match(stdout,/2 native TLS socket checks passed/);}
 finally{await transport.stop();await fixture.cleanup();}
});

test('binary reader pages retain MIME and bytes over pinned HTTPS with header-only authentication',async()=>{
 const expected=Buffer.from([0,1,2,255]);
 const transport=createSecureTransport({key,cert,handle:async request=>request.headers.authorization==='Bearer SYNTHETIC-ONLY'?{status:200,body:expected,contentType:'image/png'}:{status:401,body:{error:'Pairing required'}}});
 try{const {port}=await transport.start();const received=await new Promise((resolve,reject)=>{const request=https.request({host:'127.0.0.1',port,servername:'synthetic.local',ca:cert,agent:false,path:'/remote/v1/manga/image?handle=fixture&page=1',headers:{host:`127.0.0.1:${port}`,authorization:'Bearer SYNTHETIC-ONLY'}},response=>{const chunks=[];response.on('data',chunk=>chunks.push(chunk));response.on('end',()=>resolve({body:Buffer.concat(chunks),headers:response.headers,status:response.statusCode}));});request.on('error',reject);request.end();});assert.equal(received.status,200);assert.equal(received.headers['content-type'],'image/png');assert.equal(received.headers['cache-control'],'no-store');assert.deepEqual(received.body,expected);}
 finally{await transport.stop();}
});
