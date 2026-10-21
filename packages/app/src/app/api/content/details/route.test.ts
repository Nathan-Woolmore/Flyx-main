import {beforeEach,describe,it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const mocks=vi.hoisted(()=>({getDetails:vi.fn(),getSeasonDetails:vi.fn()}));
vi.mock('@/lib/utils/tmdb-api',()=>({tmdbApi:mocks}));
vi.mock('@/lib/utils/api-rate-limiter',()=>({contentRateLimiter:{checkLimit:()=>({allowed:true,remaining:10,resetAt:0})},getClientIP:()=> 'fixture'}));
import {GET} from './route';
beforeEach(()=>vi.resetAllMocks());
describe('TV season prefetch retains provider identities',()=>{
 it('does not replace every raw TMDB season when camel-case numbers are absent',async()=>{
  mocks.getDetails.mockResolvedValue({id:1396,seasons:[{season_number:0},{season_number:1},{season_number:2}]});
  mocks.getSeasonDetails.mockResolvedValue({season_number:1,episodes:[{episode_number:1,name:'Fixture'}]});
  const response=await GET(new NextRequest('http://fixture/api/content/details?id=1396&mediaType=tv'));const body=await response.json();
  expect(mocks.getSeasonDetails).toHaveBeenCalledWith('1396',1);expect(body.data.seasons.map((s:any)=>s.season_number)).toEqual([0,1,2]);expect(body.data.seasons[0].episodes).toBeUndefined();expect(body.data.seasons[1].episodes).toHaveLength(1);
 });
 it('accepts specials-only season zero and preserves empty published seasons',async()=>{
  mocks.getDetails.mockResolvedValue({id:1,seasons:[{season_number:0}]});mocks.getSeasonDetails.mockResolvedValue({season_number:0,episodes:[]});
  const body=await(await GET(new NextRequest('http://fixture/api/content/details?id=1&mediaType=tv'))).json();expect(mocks.getSeasonDetails).toHaveBeenCalledWith('1',0);expect(body.data.seasons).toEqual([{season_number:0,episodes:[]}]);
 });
 it('retains metadata and season numbers when optional prefetch fails',async()=>{
  mocks.getDetails.mockResolvedValue({id:1,seasons:[{season_number:3}]});mocks.getSeasonDetails.mockRejectedValue(new Error('Synthetic provider failure'));
  const response=await GET(new NextRequest('http://fixture/api/content/details?id=1&mediaType=tv'));expect(response.status).toBe(200);expect((await response.json()).data.seasons).toEqual([{season_number:3}]);
 });
});
