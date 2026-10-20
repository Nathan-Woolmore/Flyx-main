import test from 'node:test';import assert from 'node:assert/strict';
import {resolvePhoneSources} from '../../packages/app/src/lib/remote/source-resolution.mjs';
const selected={kind:'anime',contentID:38000,season:1,episode:1};
test('one valid cold anime response can finish after twelve seconds without a duplicate resolver request',async()=>{
 let providerCalls=0;
 const value=await resolvePhoneSources(selected,{fetcher:async(path,{signal})=>{
  const q=new URL(path,'http://fixture').searchParams;assert.equal(q.get('malId'),'38000');assert.equal(q.get('season'),'1');assert.equal(q.get('episode'),'1');
  if(q.get('provider')==='local')return Response.json({ok:false},{status:404});providerCalls++;
  await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,13000);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true});});
  return Response.json({ok:true,sources:[{url:'http://127.0.0.1:3891/api/stream/proxy?fixture=77',contentType:'application/x-mpegURL',type:'hls',language:'sub',quality:'720p'}]});
 }});
 assert.equal(value.sources.length,1);assert.equal(providerCalls,1);assert.equal(value.sources[0].quality,'720p');
});

test('an access refusal is not repeated',async()=>{let calls=0;await assert.rejects(resolvePhoneSources(selected,{fetcher:async path=>{if(new URL(path,'http://fixture').searchParams.get('provider')==='local')return Response.json({ok:false},{status:404});calls++;return Response.json({ok:false},{status:403});}}),e=>e.code==='PHONE_MEDIA_UNAVAILABLE');assert.equal(calls,1);});
