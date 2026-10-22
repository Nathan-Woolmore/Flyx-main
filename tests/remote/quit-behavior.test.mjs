import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const { installQuitBehavior } = createRequire(import.meta.url)('../../packages/desktop/src/quit-behavior.js');

test('repeated user Quit requests hide Flyx without shutting down its remote service', () => {
 const app=new EventEmitter();let hidden=0,shutdowns=0;
 installQuitBehavior({app,shouldBackground:()=>true,background:()=>hidden++,shutdown:()=>shutdowns++});
 for(let i=0;i<3;i++){let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});assert.equal(prevented,true);}
 assert.equal(hidden,3);assert.equal(shutdowns,0);
});

test('Quit Completely and startup failures allow shutdown and clean up the remote service', () => {
 const app=new EventEmitter();let keepRunning=true,hidden=0,shutdowns=0;
 installQuitBehavior({app,shouldBackground:()=>keepRunning,background:()=>hidden++,shutdown:()=>shutdowns++});
 keepRunning=false;let prevented=false;app.emit('before-quit',{preventDefault(){prevented=true;}});
 assert.equal(prevented,false);assert.equal(hidden,0);assert.equal(shutdowns,1);
});
