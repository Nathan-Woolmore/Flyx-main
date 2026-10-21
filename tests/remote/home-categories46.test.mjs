import test from 'node:test';
import assert from 'node:assert/strict';
import {createHome,homeSectionDefinitions} from '../../packages/desktop/src/remote/home.mjs';
import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';

test('category plans match supported Mac feeds and rank only ordered trending/popular lists',()=>{
  assert.deepEqual(homeSectionDefinitions('tv').map(s=>s.id),['trending-tv','popular-tv','top-rated-tv']);
  assert.deepEqual(homeSectionDefinitions('anime').map(s=>s.id),['popular-anime','airing-anime','top-rated-anime','upcoming-anime','anime-movies']);
  assert.deepEqual(homeSectionDefinitions('manga').map(s=>s.id),['popular-manga','latest-manga','action-manga','romance-manga','fantasy-manga']);
  assert.equal(homeSectionDefinitions('tv').filter(s=>s.ranked).length,1);
  assert.equal(homeSectionDefinitions('anime').filter(s=>s.ranked).length,1);
  assert(homeSectionDefinitions('manga').every(s=>!s.ranked));
  assert.throws(()=>homeSectionDefinitions('unknown'));
});
test('each category loads its full routes and has an independent cache',async()=>{
  const calls=[];const home=createHome(async path=>{
    calls.push(path);
    if(path.startsWith('/api/content/home'))return{sections:['trending-movies','popular-movies','top-rated-movies','trending-tv','now-playing','popular-tv'].map(id=>({id,available:true,items:[{id:7,title:'Fixture'}]}))};
    if(path.startsWith('/api/anime/jikan?'))return{data:[{mal_id:7,title:'Anime'}]};
    if(path.startsWith('/api/manga/popular?'))return{data:[{id:'fixture-manga',title:'Manga'}]};
    if(path.startsWith('/api/content/search?'))return{data:[{id:8,name:'Series',vote_count:20,vote_average:8}]};
    throw new Error('Unexpected route');
  });
  const all=await home();assert.equal(all.sections.length,7);assert.equal(calls.length,3);
  for(const [category,count]of [['tv',3],['anime',5],['manga',5]]){
    const result=await home({category});assert.equal(result.sections.length,count);assert(result.sections.every(s=>s.kind===category&&s.items.length===1&&!s.stale&&!('path'in s)));
    const before=calls.length;assert.equal((await home({category})).cached,true);assert.equal(calls.length,before);
  }
  assert.equal((await home()).sections.length,7);
});
test('category Home requests require catalogue authorization and reject arbitrary categories',async()=>{
  const calls=[];const handler=createRemoteHandler({core:{authorize:(_token,scope)=>{assert.equal(scope,'catalog.read');}},home:async spec=>{calls.push(spec);return{sections:[]};}});
  const headers={authorization:'Bearer SYNTHETIC'};
  assert.equal((await handler({method:'GET',path:'/remote/v1/home?category=tv',headers})).status,200);
  assert.deepEqual(calls,[{category:'tv',refresh:false}]);
  assert.equal((await handler({method:'GET',path:'/remote/v1/home?category=anything',headers})).status,400);
  assert.equal((await handler({method:'GET',path:'/remote/v1/home?category=tv'})).status,401);
  assert.equal(calls.length,1);
});
