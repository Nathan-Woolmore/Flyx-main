import {it,expect,vi} from 'vitest';
import {NextRequest} from 'next/server';
const state=vi.hoisted(()=>({stalled:false,extracts:0}));
vi.mock('@/lib/auth/get-session',()=>({getSession:()=>state.stalled?new Promise(()=>{}):Promise.resolve(null)}));
vi.mock('@/lib/extraction',()=>({pipeline:{extract:()=>{state.extracts++;return{};}}}));
import {GET} from '@/app/api/stream/vlc/route';
it('VLC classifies an authentication stall as503 and never extracts or signs a source',async()=>{
 state.stalled=true;const response=await GET(new NextRequest('http://127.0.0.1:3891/api/stream/vlc?format=json&tmdbId=1&mediaType=movie'));
 expect(response.status).toBe(503);expect(await response.json()).toMatchObject({ok:false,code:'PHONE_AUTH_TIMEOUT'});expect(state.extracts).toBe(0);
 state.stalled=false;const unauthorized=await GET(new NextRequest('http://127.0.0.1:3891/api/stream/vlc?format=json'));
 expect(unauthorized.status).toBe(401);expect(state.extracts).toBe(0);
});
