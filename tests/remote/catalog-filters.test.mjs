import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogPath,createCatalog,normalizeCatalog} from '../../packages/desktop/src/remote/catalog.mjs';
import {createRemoteHandler} from '../../packages/desktop/src/remote/protocol.mjs';
const url=value=>new URL(value,'http://fixture');
test('movie and TV discovery forward combined catalogue-wide filters and provider cursors',()=>{
 for(const kind of ['movie','tv']){
  const p=url(catalogPath({kind,genre:'35',yearFrom:2000,yearTo:2020,minRating:7,sort:'rating',page:6}));
  assert.equal(p.pathname,'/api/content/search');for(const [k,v]of Object.entries({type:kind,genre:'35',yearFrom:'2000',yearTo:'2020',minRating:'7',sort:'rating',page:'6'}))assert.equal(p.searchParams.get(k),v);
 }
});
test('text plus filters reach backend search without filtering a fetched phone page',()=>{
 const p=url(catalogPath({kind:'movie',query:'space & time',genre:'878',yearFrom:1990,minRating:6,sort:'rating',page:2}));
 assert.equal(p.searchParams.get('q'),'space & time');assert.equal(p.searchParams.get('genre'),'878');assert.equal(p.searchParams.get('sort'),'relevance');assert.equal(p.searchParams.get('page'),'2');
});
test('anime browse and text use the shared provider filter path, including fallback-compatible IDs',()=>{
 const p=url(catalogPath({kind:'anime',query:'a & b',genre:'10',yearFrom:2010,yearTo:2020,minRating:8,sort:'rating',page:3}));
 const nested=url(p.searchParams.get('path'));assert.equal(nested.pathname,'/anime');
 for(const[k,v]of Object.entries({q:'a & b',genres:'10',start_date:'2010-01-01',end_date:'2020-12-31',min_score:'8',order_by:'score',sort:'desc',page:'3'}))assert.equal(nested.searchParams.get(k),v);
 const popular=url(url(catalogPath({kind:'anime'})).searchParams.get('path'));assert.equal(popular.searchParams.get('order_by'),'members');assert.equal(popular.searchParams.get('sort'),'desc');
});
test('manga exposes real supported feeds and search, refuses unsupported filters/pagination',()=>{
 assert.equal(url(catalogPath({kind:'manga',sort:'release_date'})).searchParams.get('type'),'latest');
 assert.equal(url(catalogPath({kind:'manga',query:'One Piece'})).pathname,'/api/manga/search');
 for(const extra of [{genre:'1'},{yearFrom:2000},{minRating:1},{page:2},{sort:'rating'}])assert.throws(()=>catalogPath({kind:'manga',...extra}),/unavailable/);
});
test('invalid filters cannot become arbitrary backend route parameters',()=>{
 for(const extra of [{genre:'&admin=1'},{yearFrom:1800},{yearFrom:2020,yearTo:2000},{minRating:11},{sort:'shell'},{page:501}])assert.throws(()=>catalogPath({kind:'movie',...extra}));
});
test('normalization deduplicates stable kind/ID and preserves sparse provider continuation',()=>{
 const result=normalizeCatalog({data:[{id:1,title:'A'},{id:1,title:'A'}],nextPage:7},'movie',false,5);assert.equal(result.items.length,1);assert.equal(result.nextPage,7);
 assert.equal(normalizeCatalog({data:[],nextPage:7},'tv',false,5).nextPage,7);
 assert.equal(normalizeCatalog({data:[],pagination:{current_page:3,has_next_page:true}},'anime',false,3).nextPage,4);
 assert.equal(normalizeCatalog({data:[],nextPage:2},'manga').nextPage,null);
});
test('upstream failures are errors, not a fake empty catalogue',()=>{
 assert.throws(()=>normalizeCatalog({data:[],error:'Upstream unavailable'},'anime'));
 assert.throws(()=>normalizeCatalog({success:false,data:[]},'movie'));
});
test('authenticated remote protocol forwards every combined filter to the adapter',async()=>{
 let query;const handler=createRemoteHandler({core:{authorize:()=>({})},catalog:async value=>(query=value,{items:[],nextPage:null})});
 const response=await handler({method:'GET',path:'/remote/v1/catalog?kind=tv&q=star&genre=18&yearFrom=2001&yearTo=2020&minRating=7&sort=release_date&page=6',headers:{authorization:'Bearer SYNTHETIC-ONLY'}});
 assert.equal(response.status,200);assert.equal(query.genre,'18');assert.equal(query.yearFrom,2001);assert.equal(query.yearTo,2020);assert.equal(query.minRating,7);assert.equal(query.page,6);
});
test('adapter uses full backend pages and never manufactures a next page for manga',async()=>{
 const paths=[];const catalog=createCatalog(async path=>(paths.push(path),{data:[],nextPage:5}));
 assert.equal((await catalog({kind:'movie',query:'rare',genre:'18',page:1})).nextPage,5);assert.equal(url(paths[0]).searchParams.get('genre'),'18');
});
