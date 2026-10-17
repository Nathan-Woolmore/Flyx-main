import { createHash, timingSafeEqual } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest();
const equal = (a, b) => a.length === b.length && timingSafeEqual(a, b);
const allowed = new Set(['play', 'resume', 'pause', 'seek', 'stop', 'volume', 'mute', 'cast.discover', 'cast.connect', 'cast.disconnect']);

// Transport-independent candidate. Importing never opens a listener, generates credentials,
// touches Flyx user data, or talks to a player/TV. Only the Mac's local approval UI may call approve().
export class RemoteCore {
  #devices = new Map(); #offer; #attempts = 0;
  constructor({ now = Date.now, makeToken, makeID, dispatch, loadDevices=()=>[], saveDevices=()=>{} }) {
    this.now = now; this.makeToken = makeToken; this.makeID = makeID; this.dispatch = dispatch; this.saveDevices=saveDevices;
    for(const value of loadDevices()) {
      if(!/^[a-f0-9]{64}$/.test(value.digest)||!Array.isArray(value.scopes)||value.scopes.some(s=>!['catalog.read','playback.control','downloads.read','downloads.write','watchlist.write'].includes(s))||!Number.isFinite(value.expires))throw new Error('Invalid remembered permissions');
      if(value.expires>this.now())this.#devices.set(value.id,{...value,scopes:new Set(value.scopes),digest:Buffer.from(value.digest,'hex'),seen:new Set()});
    }
  }
  persist(){this.saveDevices([...this.#devices.values()].map(({id,name,scopes,digest,expires})=>({id,name,scopes:[...scopes],digest:digest.toString('hex'),expires})));}
  approveDigest({id,name,digest},scopes=['catalog.read','playback.control']){
    if(typeof id!=='string'||!/^[a-zA-Z0-9-]{8,80}$/.test(id)||typeof name!=='string'||!name||name.length>80||!/^[a-f0-9]{64}$/.test(digest)||!Array.isArray(scopes)||scopes.some(s=>!['catalog.read','playback.control','downloads.read','downloads.write','watchlist.write'].includes(s)))throw new Error('Invalid enrollment');
    this.#devices.set(id,{id,name,scopes:new Set(scopes),digest:Buffer.from(digest,'hex'),expires:this.now()+90*86400000,seen:new Set()});
    try{this.persist();}catch(error){this.#devices.delete(id);throw error;}return {ok:true};
  }
  openPairing(secret) {
    if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/.test(secret)) throw new Error('256-bit out-of-band pairing secret required');
    this.#offer = { digest: hash(secret), expires: this.now() + 120_000 };
    this.#attempts = 0;
  }
  cancelPairing() { this.#offer = undefined; }
  verifyOffer(secret) {
    if (!this.#offer || ++this.#attempts > 5 || this.now() >= this.#offer.expires) throw new Error('Pairing unavailable');
    if (typeof secret !== 'string' || secret.length > 512 || !equal(hash(secret), this.#offer.digest)) throw new Error('Pairing rejected');
  }
  approve({ secret, name, scopes = ['catalog.read', 'playback.control'] }) {
    this.verifyOffer(secret);
    if (typeof name !== 'string' || name.length < 1 || name.length > 80) throw new Error('Invalid device name');
    if (!Array.isArray(scopes) || scopes.some(s => !['catalog.read', 'playback.control', 'downloads.read', 'downloads.write','watchlist.write'].includes(s))) throw new Error('Invalid scope');
    const id = this.makeID(), token = this.makeToken();
    if (typeof token !== 'string' || token.length < 43) throw new Error('Invalid token generator');
    this.#devices.set(id, { id, name, scopes: new Set(scopes), digest: hash(token), expires: this.now() + 86_400_000, seen: new Set() });
    this.persist();
    this.#offer = undefined;
    return { deviceID: id, token, expiresIn: 86400, scopes: [...scopes] };
  }
  authorize(token, scope) {
    if (typeof token !== 'string' || token.length > 512) throw new Error('Unauthorized');
    const digest = hash(token);
    for (const device of this.#devices.values()) {
      if (equal(device.digest, digest) && this.now() < device.expires && device.scopes.has(scope)) return device;
    }
    throw new Error('Unauthorized');
  }
  listDevices() { return [...this.#devices.values()].map(({ id, name, scopes, expires }) => ({ id, name, scopes: [...scopes], expires })); }
  updateScopes(id,scopes){const device=this.#devices.get(id);if(!device||!Array.isArray(scopes)||scopes.some(s=>!['catalog.read','playback.control','downloads.read','downloads.write','watchlist.write'].includes(s)))throw new Error('Invalid permissions');const previous=device.scopes;device.scopes=new Set(scopes);try{this.persist();}catch(error){device.scopes=previous;throw error;}return{ok:true};}
  revokeAll() { this.#devices.clear(); this.cancelPairing(); this.persist(); }
  clearMemory() { this.#devices.clear(); this.cancelPairing(); }
  revoke(id) { const deleted=this.#devices.delete(id);this.persist();return deleted; }
  async command(token, command) {
    const device = this.authorize(token, 'playback.control');
    if (!command || !allowed.has(command.type) || typeof command.id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(command.id)) throw new Error('Invalid command');
    if (device.seen.has(command.id)) throw new Error('Duplicate command');
    if (command.type === 'play' && command.seconds!==undefined && (!Number.isFinite(command.seconds)||command.seconds<0||command.seconds>86400))throw new Error('Invalid resume position');
    if (command.type === 'seek' && (!Number.isFinite(command.seconds) || command.seconds < 0 || command.seconds > 86400)) throw new Error('Invalid seek');
    if(['volume','mute'].includes(command.type)&&(!['mac','tv'].includes(command.output)||(command.type==='volume'?(!Number.isFinite(command.value)||command.value<0||command.value>1):typeof command.value!=='boolean')))throw new Error('Invalid audio command');
    if (command.type === 'play' && (!['movie','tv','anime'].includes(command.kind) || !Number.isSafeInteger(command.contentID) || command.contentID <= 0)) throw new Error('Invalid content');
    if (command.type === 'play' && command.kind !== 'movie' && (!Number.isSafeInteger(command.episode) || command.episode <= 0 || (command.kind === 'tv' && (!Number.isSafeInteger(command.season) || command.season < 0)))) throw new Error('Episode selection required');
    if (command.type === 'cast.connect' && (typeof command.receiverID !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(command.receiverID))) throw new Error('Discovered receiver ID required');
    if (Object.keys(command).some(k => !['id','type','kind','contentID','season','episode','seconds','receiverID','output','value'].includes(k))) throw new Error('Unexpected command field');
    if (device.seen.size >= 1024) device.seen.delete(device.seen.values().next().value);
    device.seen.add(command.id);
    // Dispatch must return the Mac's real completion acknowledgement; queued is never reported as playing.
    const result = await this.dispatch(structuredClone(command));
    return { commandID: command.id, ...result };
  }
}
