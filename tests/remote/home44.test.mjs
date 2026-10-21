import test from 'node:test';
import assert from 'node:assert/strict';
import {createHome,normalizeHomeItems} from '../../packages/desktop/src/remote/home.mjs';

test('rank badges preserve provider positions and never invent a merged ranking',()=>{
  const items=normalizeHomeItems([{id:7,title:'First'},{id:7,title:'Duplicate'},{id:8,title:'Third'}],'movie',true);
  assert.deepEqual(items.map(item=>item.rank),[1,3]);
  assert.equal(items[0].title.rating,null);
  assert(!('rank' in normalizeHomeItems([{id:2,title:'Anime'}],'anime',false)[0]));
});
function fixture(){
  let time=1000,failed=false;const calls=[];
  const home=createHome(async path=>{
    calls.push(path);if(failed)throw new Error('Synthetic provider failure');
    if(path==='/api/content/home')return{sections:[{id:'trending-movies',available:true,items:[{id:7,title:'Movie',poster_path:'/fixture.jpg',backdrop_path:'/wide.jpg'}]},{id:'trending-tv',available:true,items:[{id:7,name:'Series'}]}]};
    if(path.startsWith('/api/anime/jikan?'))return{data:[{mal_id:2,title:'Anime',images:{jpg:{image_url:'https://example.invalid/anime.jpg'}}}]};
    if(path==='/api/manga/popular?type=popular&limit=16')return{data:[{id:'fixture-manga',title:'Manga'}]};
    throw new Error('Unexpected route');
  },{now:()=>time});
  return{home,calls,fail:()=>{failed=true;time+=180001;}};
}
test('Home reuses fixed Mac routes, keeps mixed identities and coalesces refreshes',async()=>{
  const f=fixture();const [first,second]=await Promise.all([f.home(),f.home()]);
  assert.deepEqual(first,second);assert.equal(f.calls.length,3);
  const kinds=new Set(first.sections.flatMap(s=>s.items.map(i=>i.title.kind)));
  assert.deepEqual([...kinds].sort(),['anime','manga','movie','tv']);
  assert.equal(first.sections[0].items[0].title.backdropURL,'https://image.tmdb.org/t/p/w780/wide.jpg');
  assert.equal((await f.home()).cached,true);assert.equal(f.calls.length,3);
  await f.home({refresh:true});assert.equal(f.calls.length,6);
});
test('provider failure retains per-row cached titles with explicit stale state',async()=>{
  const f=fixture();const original=await f.home();f.fail();const stale=await f.home();
  assert.deepEqual(stale.sections[0].items,original.sections[0].items);
  assert.equal(stale.sections[0].stale,true);assert.match(stale.sections[0].error,/previously loaded/);
  assert.equal(stale.sections[0].updatedAt,original.sections[0].updatedAt);
  assert.equal(stale.sections.find(row=>row.id==='top-rated-movies').items.length,0);
});
