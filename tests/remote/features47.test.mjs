import test from 'node:test';
import assert from 'node:assert/strict';
import {movieTrailer,normalizeCatalog} from '../../packages/desktop/src/remote/catalog.mjs';
import {downloadRequest,publicJobs} from '../../packages/desktop/src/remote/downloads.mjs';
import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';
test('trailers use only safe YouTube trailer identities, prefer official matching language, and hide absent data',()=>{
 const data={id:1,title:'Fixture',videos:{results:[{site:'YouTube',type:'Clip',key:'AAAAAAAAAAA'},{site:'YouTube',type:'Trailer',key:'bad<script>'},{site:'YouTube',type:'Trailer',key:'BBBBBBBBBBB',iso_639_1:'en'},{site:'YouTube',type:'Trailer',key:'CCCCCCCCCCC',iso_639_1:'en',official:true}]}};
 assert.equal(movieTrailer(data).videoID,'CCCCCCCCCCC');assert.equal(movieTrailer({}),null);assert.equal(normalizeCatalog({data},'movie',true).trailer.videoID,'CCCCCCCCCCC');assert.equal(normalizeCatalog({data},'tv',true).trailer,null);
});
test('Trash requires exact revision; public jobs never expose filesystem paths',()=>{
 const id='11111111-1111-4111-8111-111111111111',revision='a'.repeat(64);
 assert.deepEqual(downloadRequest('trash',{id,revision}),{path:'/api/downloads/'+id,method:'POST',body:{intent:'trash',revision}});assert.throws(()=>downloadRequest('trash',{id}));
 const row=publicJobs({ok:true,jobs:[{id,status:'done',canTrash:true,fileRevision:revision,filepath:'/synthetic/private/file'}]}).jobs[0];assert.equal(row.canTrash,true);assert.equal(row.fileRevision,revision);assert(!('filepath'in row));
});
test('Trash uses existing download-management authorization and never catalogue-only scope',async()=>{
 let called=false;const handler=createRemoteHandler({core:{authorize:(_t,scope)=>{assert.equal(scope,'downloads.write');throw new Error('Unauthorized');}},downloads:async()=>{called=true;}});
 assert.equal((await handler({method:'POST',path:'/remote/v1/downloads',headers:{authorization:'Bearer fixture'},body:{operation:'trash'}})).status,401);assert.equal(called,false);
});
