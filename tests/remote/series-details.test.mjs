import test from 'node:test';import assert from 'node:assert/strict';
import {createCatalog,catalogFailure} from '../../packages/desktop/src/remote/catalog.mjs';
import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';
test('default chooses an available non-special season and reuses real prefetched episodes',async()=>{
 const paths=[];const catalog=createCatalog(async path=>(paths.push(path),{data:{id:7,name:'Fixture',seasons:[{season_number:0},{season_number:3,episodes:[{episode_number:1,name:'Fixture episode'}]}]}}));
 const value=await catalog({kind:'tv',id:'7'},true);assert.equal(value.selectedSeason,3);assert.equal(value.seasons[1].episodes[0].number,1);assert.equal(paths.length,1);
});
test('season zero and explicit later seasons use catalogue access without the web-session proxy',async()=>{
 for(const number of [0,2]){
 const paths=[];const catalog=createCatalog(async path=>{paths.push(path);if(path.startsWith('/api/content/details'))return{data:{id:7,name:'Fixture',seasons:[{season_number:0},{season_number:2}]}};const url=new URL(path,'http://fixture');assert.equal(url.pathname,'/api/content/season');assert.equal(url.searchParams.get('season'),String(number));return{data:{episodes:[{episode_number:1,name:'Episode'}]}};});
 const value=await catalog({kind:'tv',id:'7',season:number},true);assert.equal(value.selectedSeason,number);assert.equal(value.seasons.find(s=>s.number===number).episodes.length,1);assert.equal(paths.length,2);
 }
});
test('no published seasons is valid; unavailable explicit season is actionable',async()=>{
 const catalog=createCatalog(async()=>({data:{id:7,name:'Fixture',seasons:[]}}));assert.deepEqual((await catalog({kind:'tv',id:'7'},true)).seasons,[]);
 const other=createCatalog(async()=>({data:{id:7,name:'Fixture',seasons:[{season_number:0,episodes:[]}]}}));await assert.rejects(other({kind:'tv',id:'7',season:1},true),/season is unavailable/);
});
test('episode provider failure preserves metadata with a truthful retry warning',async()=>{
 const catalog=createCatalog(async path=>{if(path.startsWith('/api/content/details'))return{data:{id:7,name:'Fixture',seasons:[{season_number:1}]}};throw catalogFailure('CATALOG_RATE_LIMITED');});const value=await catalog({kind:'tv',id:'7'},true);assert.equal(value.title,'Fixture');assert.match(value.seasonError,/busy/);assert.equal(value.seasons[0].episodes.length,0);
});
test('missing provider fields do not produce duplicate season or invalid episode IDs',async()=>{
 const catalog=createCatalog(async()=>({data:{id:7,name:'Fixture',seasons:[{}, {season_number:0,episodes:[]},{season_number:0},{season_number:2,episodes:[{episode_number:1},{episode_number:null}]}]}}));const value=await catalog({kind:'tv',id:'7',season:2},true);assert.deepEqual(value.seasons.map(s=>s.number),[0,2]);assert.equal(value.seasons[1].episodes.length,1);
});
test('safe provider error codes become actionable statuses without upstream secrets',async()=>{
 for(const [code,status]of [['CATALOG_NOT_FOUND',404],['CATALOG_RATE_LIMITED',429],['CATALOG_TIMEOUT',504],['CATALOG_UNAVAILABLE',502]]){
 const handler=createRemoteHandler({core:{authorize:()=>({})},catalog:async()=>{throw Object.assign(new Error('SECRET-UPSTREAM-URL'),{code});}});const result=await handler({method:'GET',path:'/remote/v1/details?kind=tv&id=7',headers:{authorization:'Bearer SYNTHETIC-ONLY'}});assert.equal(result.status,status);assert.equal(JSON.stringify(result).includes('SECRET'),false);assert.equal(result.body.code,code);
 }
});
