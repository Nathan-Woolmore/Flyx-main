import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadSelection,publicJobs,downloadRequest,createDownloads} from '../../packages/desktop/src/remote/downloads.mjs';
const job={id:'11111111-1111-4111-8111-111111111111',kind:'video',tmdbId:7,mediaType:'tv',season:0,episode:2,status:'done',localPlaybackAvailable:true,label:'Fixture',progress:100,bytes:120};
test('download projection preserves exact identity and file availability without leaking private paths',()=>{
 assert.deepEqual(downloadSelection(job),{kind:'tv',contentID:7,season:0,episode:2});
 assert.equal(downloadSelection({...job,episode:undefined}),null);
 assert.equal(downloadSelection({...job,mediaType:'movie'}).kind,'movie');
 const value=publicJobs({ok:true,jobs:[{...job,filepath:'/private/media.mp4',error:'https://private.invalid/key',collectionPlan:{token:'secret'}}]}).jobs[0];
 assert.equal(value.localPlaybackAvailable,true);assert.equal(publicJobs({ok:true,jobs:[{...job,localPlaybackAvailable:false}]}).jobs[0].localPlaybackAvailable,false);
 assert.equal(/private|https|token/.test(JSON.stringify(value)),false);
});
test('cancellation and history removal carry distinct explicit intent',()=>{
 assert.deepEqual(downloadRequest('cancel',{id:job.id}).body,{intent:'cancel'});
 assert.deepEqual(downloadRequest('removeHistory',{id:job.id}).body,{intent:'remove-history'});
 assert.throws(()=>downloadRequest('removeHistory',{id:'../../file'}));
});
test('download cards reuse catalogue metadata and metadata failures leave an honest fallback',async()=>{
 let requests=0;
 const list=createDownloads(async()=>({ok:true,jobs:[job]}),async query=>{requests++;assert.deepEqual(query,{kind:'tv',id:'7'});return{id:'7',kind:'tv',title:'Canonical title',overview:'Known overview',posterURL:'https://image.tmdb.org/t/p/w500/fixture.jpg'};});
 assert.equal((await list('list')).jobs[0].title.title,'Canonical title');
 assert.equal((await list('list')).jobs[0].title.title,'Canonical title');assert.equal(requests,1);
 const failed=createDownloads(async()=>({ok:true,jobs:[job]}),async()=>{throw new Error('Provider offline');});
 assert.equal((await failed('list')).jobs[0].title,undefined);
});

test('slow metadata cannot serially block the library or start an unbounded request burst',async()=>{
 let calls=0;
 const jobs=Array.from({length:40},(_,i)=>({...job,tmdbId:i+1}));
 const list=createDownloads(async()=>({ok:true,jobs}),()=>{calls++;return new Promise(()=>{});},{metadataBudgetMs:15});
 const start=Date.now();const value=await list('list');
 assert.equal(value.jobs.length,40);assert.equal(calls,4);assert.ok(Date.now()-start<250);
 await list('list');assert.equal(calls,4);
});
test('canonical metadata with the wrong title identity is not attached',async()=>{
 const list=createDownloads(async()=>({ok:true,jobs:[job]}),async()=>({id:'8',kind:'tv',title:'Wrong title'}));
 assert.equal((await list('list')).jobs[0].title,undefined);
});
