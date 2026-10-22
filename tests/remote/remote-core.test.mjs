import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteCore } from './remote-core.mjs';
const fixture = () => {
  let now = 1000; const calls = [];
  const core = new RemoteCore({ now: () => now, makeID: () => 'fixture-phone', makeToken: () => 'SYNTHETIC-ONLY-'.repeat(4), dispatch: async c => { calls.push(c); return { ok: true }; } });
  const pair = scopes => { core.openPairing('a'.repeat(64)); return core.approve({ secret: 'a'.repeat(64), name: 'Synthetic iPhone', scopes }); };
  return { core, calls, pair, advance: delta => now += delta };
};
test('approved pairing never expires, is one-use and stores no plaintext credential in listing', () => {
 const f = fixture(), grant = f.pair();
 assert.equal(f.core.authorize(grant.token, 'catalog.read').name, 'Synthetic iPhone');
 assert.equal(JSON.stringify(f.core.listDevices()).includes(grant.token), false);
 assert.throws(() => f.core.approve({ secret: 'a'.repeat(64), name: 'Replay' }));
 assert.equal(grant.expiresIn,0);
 f.advance(100*365*86_400_000);
 assert.equal(f.core.authorize(grant.token, 'catalog.read').name, 'Synthetic iPhone');
 assert.equal(f.core.listDevices()[0].expires,0);
});
test('revocation blocks all future commands', async () => {
 const f = fixture(), grant = f.pair(); f.core.revoke(grant.deviceID);
 await assert.rejects(f.core.command(grant.token, { id: 'one', type: 'pause' })); assert.equal(f.calls.length, 0);
});
test('scope, command validation, arbitrary URLs and replay cannot reach dispatcher', async () => {
 const f = fixture(), grant = f.pair(['catalog.read']);
 await assert.rejects(f.core.command(grant.token, { id: 'one', type: 'pause' }));
 const g = fixture(), token = g.pair().token;
 for (const c of [{ type: 'shell' }, {type:'seek', seconds: -1}, {type:'play', kind:'tv', contentID:1}, {type:'pause', url:'https://arbitrary.invalid'}]) await assert.rejects(g.core.command(token, { id: 'bad', ...c }));
 assert.equal(g.calls.length, 0);
 await g.core.command(token, { id:'one', type:'pause' });
 await assert.rejects(g.core.command(token, { id:'one', type:'pause' })); assert.equal(g.calls.length, 1);
});
test('pairing window expires and locks after five failed guesses', () => {
 const f = fixture(); f.core.openPairing('a'.repeat(64));
 for(let i=0;i<5;i++) assert.throws(() => f.core.approve({ secret:'b'.repeat(64), name:'No' }));
 assert.throws(() => f.core.approve({ secret:'a'.repeat(64), name:'No' }));
 f.core.openPairing('a'.repeat(64)); f.advance(120001);
 assert.throws(() => f.core.approve({ secret:'a'.repeat(64), name:'No' }));
});
