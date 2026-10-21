export class PairingApproval {
  #pending; #grant; #expires = 0;
  constructor({ core, makeSecret, makeID, enrollmentStore, now = Date.now }) { Object.assign(this, { core, makeSecret, makeID, enrollmentStore, now }); }
  cancel() { this.#pending=undefined;this.#grant=undefined;this.#expires=0;this.core.cancelPairing(); }
  begin() {
    const secret = this.makeSecret(); this.core.openPairing(secret);
    this.#pending = undefined; this.#grant = undefined; this.#expires = this.now() + 120000;
    return { secret, expiresAt: this.#expires }; // Local UI only, never /info.
  }
  request({ secret, name }) {
    if (this.now() >= this.#expires || this.#pending) throw new Error('Pairing unavailable');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid device name');
    this.core.verifyOffer(secret);
    const id = this.makeID(); this.#pending = {id, name, secret};
    return { requestID: id, status: 'awaiting-mac-approval' };
  }
  snapshot() { const managed=this.enrollmentStore?.pending();return { pending: this.#pending && this.now() < this.#expires ? { id: this.#pending.id, name: this.#pending.name } : managed ? {id:managed.id,name:managed.name,managed:true} : null, devices: this.core.listDevices() }; }
  approve(id, scopes = ['catalog.read', 'playback.control']) {
    const managed=this.enrollmentStore?.pending();
    if(managed?.id===id){const result=this.core.approveDigest(managed,scopes);this.enrollmentStore.removePending(id);return result;}
    if (!this.#pending || this.#pending.id !== id || this.now() >= this.#expires) throw new Error('Request expired');
    this.#grant = {id, value:this.core.approve({...this.#pending, scopes})};
    this.#pending = undefined;
    return {ok:true}; // Device token never reaches approval renderer.
  }
  reject(id) {
    if(this.enrollmentStore?.pending()?.id===id){this.enrollmentStore.removePending(id);return{ok:true};}
    if (this.#pending?.id !== id) throw new Error('Unknown request');
    this.#pending = undefined; this.#grant = undefined; this.core.cancelPairing(); this.#expires = 0;
    return {ok:true};
  }
  collect(id) {
    if (this.now() >= this.#expires) { this.#grant = undefined; throw new Error('Request expired'); }
    if (this.#grant?.id === id) { const grant=this.#grant.value; this.#grant=undefined; return {status:'approved', ...grant}; }
    if (this.#pending?.id === id) return {status:'awaiting-mac-approval'};
    throw new Error('Unknown request');
  }
}
