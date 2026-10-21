import {createHash, timingSafeEqual} from 'node:crypto';
export class PairingApproval {
  #pending; #grant; #collected; #expires = 0;
  constructor({ core, makeSecret, makeID, enrollmentStore, now = Date.now }) { Object.assign(this, { core, makeSecret, makeID, enrollmentStore, now }); }
  cancel() { this.#pending=undefined;this.#grant=undefined;this.#collected=undefined;this.#expires=0;this.core.cancelPairing(); }
  begin() {
    const secret = this.makeSecret(); this.core.openPairing(secret);
    this.#pending = undefined; this.#grant = undefined; this.#collected = undefined; this.#expires = this.now() + 120000;
    return { secret, expiresAt: this.#expires }; // Local UI only, never /info.
  }
  request({ secret, name }) {
    if (this.now() >= this.#expires) throw Object.assign(new Error('Pairing unavailable'),{code:'PAIRING_CODE_EXPIRED'});
    if (this.#pending) throw Object.assign(new Error('Pairing unavailable'),{code:'PAIRING_BUSY'});
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid device name');
    this.core.verifyOffer(secret);
    const id = this.makeID(); this.#pending = {id, name, secret};
    return { requestID: id, status: 'awaiting-mac-approval' };
  }
  snapshot() { const managed=this.enrollmentStore?.pending();return { pending: this.#pending && this.now() < this.#expires ? { id: this.#pending.id, name: this.#pending.name } : managed ? {id:managed.id,name:managed.name,managed:true} : null, devices: this.core.listDevices() }; }
  approve(id, scopes = ['catalog.read', 'playback.control']) {
    const managed=this.enrollmentStore?.pending();
    if(managed?.id===id){const result=this.core.approveDigest(managed,scopes);this.enrollmentStore.removePending(id);return result;}
    if (!this.#pending || this.#pending.id !== id || this.now() >= this.#expires) throw Object.assign(new Error('Request expired'),{code:'PAIRING_CODE_EXPIRED'});
    const digest=createHash('sha256').update(this.#pending.secret).digest();
    this.#grant = {id, digest, value:this.core.approve({...this.#pending, scopes})};
    this.#pending = undefined;
    return {ok:true}; // Device token never reaches approval renderer.
  }
  reject(id) {
    if(this.enrollmentStore?.pending()?.id===id){this.enrollmentStore.removePending(id);return{ok:true};}
    if (this.#pending?.id !== id) throw new Error('Unknown request');
    this.#pending = undefined; this.#grant = undefined; this.core.cancelPairing(); this.#expires = 0;
    return {ok:true};
  }
  cancelRequest({requestID,secret}) {
    if(this.now()>=this.#expires)throw Object.assign(new Error('Request expired'),{code:'PAIRING_CODE_EXPIRED'});
    if(this.#pending?.id===requestID){this.core.verifyOffer(secret);this.#pending=undefined;return{ok:true};}
    const owned = this.#grant?.id===requestID ? {digest:this.#grant.digest,deviceID:this.#grant.value.deviceID} : this.#collected?.id===requestID ? this.#collected : undefined;
    if(owned){
      if(typeof secret!=='string'||secret.length>512||!timingSafeEqual(createHash('sha256').update(secret).digest(),owned.digest))throw Object.assign(new Error('Pairing rejected'),{code:'PAIRING_CODE_REJECTED'});
      this.core.revoke(owned.deviceID);this.#grant=undefined;this.#collected=undefined;return{ok:true};
    }
    throw new Error('Unknown request');
  }
  collect(id) {
    if (this.now() >= this.#expires) { this.#grant = undefined; this.#collected=undefined; throw Object.assign(new Error('Request expired'),{code:'PAIRING_CODE_EXPIRED'}); }
    if (this.#grant?.id === id) {
      const grant=this.#grant.value;
      // Retain only cancellation proof until this offer expires, never the collected token.
      this.#collected={id,digest:this.#grant.digest,deviceID:grant.deviceID};
      this.#grant=undefined; return {status:'approved', ...grant};
    }
    if (this.#pending?.id === id) return {status:'awaiting-mac-approval'};
    throw new Error('Unknown request');
  }
}
