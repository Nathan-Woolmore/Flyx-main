"use client";

import {useCallback, useEffect, useState} from 'react';
import {remoteAPI, type RemoteAPI} from '@/lib/remote/RemoteHost';
import styles from './RemotePairingSettings.module.css';

type Approval = Awaited<ReturnType<RemoteAPI['approvalState']>>;
type Setup = Awaited<ReturnType<RemoteAPI['setupState']>>;
type Transport = Awaited<ReturnType<RemoteAPI['transportState']>>;
type Offer = {code: string; expiresAt: number; deviceIDs: string[]};

export default function RemotePairingSettings() {
  const [desktop, setDesktop] = useState(true);
  const [state, setState] = useState<Approval | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [offer, setOffer] = useState<Offer | null>(null);
  const [now, setNow] = useState(Date.now());
  const [downloads, setDownloads] = useState(false);
  const [working, setWorking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const busy = working || restarting;
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    const api = remoteAPI();
    if (!api) { setDesktop(false); return; }
    const [approval, network, connection] = await Promise.all([api.approvalState(), api.transportState(), api.setupState()]);
    setState(approval); setTransport(network); setSetup(connection);
  }, []);

  useEffect(() => {
    let active = true;
    void refresh().catch(() => { if (active) setError('Could not read the Mac connection. Refresh to try again.'); });
    const timer = setInterval(() => {
      const api = remoteAPI();
      if (api) void api.approvalState().then(value => { if (active) setState(value); }).catch(() => {});
    }, 1500);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    if (!offer) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [offer]);
  useEffect(() => {
    if (offer && state?.devices.some(device => !offer.deviceIDs.includes(device.id))) {
      setOffer(null); setMessage('iPhone approved. Return to your iPhone to finish connecting.');
    }
  }, [state, offer]);

  async function act(action: (api: RemoteAPI) => Promise<void>) {
    const api = remoteAPI(); if (!api) return;
    setWorking(true); setError(''); setMessage('');
    try { await action(api); await refresh(); }
    catch { setError('Could not complete the connection request. Refresh and try again.'); }
    finally { setWorking(false); }
  }
  const expired = !!offer && now >= offer.expiresAt;
  const seconds = offer ? Math.max(0, Math.ceil((offer.expiresAt - now) / 1000)) : 0;
  const ready = setup?.available && !setup.needsSetup && transport?.listening;

  return <section className={styles.panel} aria-label="Connect your iPhone">
    <span className={styles.eyebrow}>iPhone app</span>
    <h2>Connect your iPhone</h2>
    <p>One connection code links the Flyx iPhone app to this Mac. Pairing does not expire and stays active until you revoke it. Keep both devices on the same home network.</p>
    <ol className={styles.steps}>
      <li><strong>1 · On this Mac</strong><span>Create a connection code below and copy it.</span></li>
      <li><strong>2 · On your iPhone</strong><span>Open Flyx → App mode → Mac Remote. On “Your Mac. In reach.”, paste the code and connect.</span></li>
      <li><strong>3 · Back on this Mac</strong><span>Check the iPhone name and approve its request below.</span></li>
    </ol>
    {!desktop ? <p className={styles.notice}>Open Settings → Connect Devices in the Flyx desktop app to create a code. The browser address below is a separate way to use Flyx.</p> : <>
      {setup?.needsSetup && <div className={styles.notice}>
        <strong>{setup.status === 'new' ? 'Set up this Mac once' : 'Update the connection for this Mac'}</strong>
        <p>{setup.replaceIdentity ? 'Flyx can create a secure connection using this Mac’s current name. You do not need to rename your Mac. You will review the change before any identity is created.' : 'This Mac’s home-network address changed. Update the listener while keeping its certificate and phone enrollment.'}</p>
        {setup.previousEndpoint && <p>Previous connection: <code>{setup.previousEndpoint}</code></p>}
        <button className={styles.primary} disabled={busy || !setup.available} onClick={() => act(async api => {
          const result = await api.setupConnection();
          if (result.cancelled) setMessage('Setup cancelled. Your existing connection is unchanged.');
          else if (result.restartRequired) { setRestarting(true); setMessage('Flyx is restarting. Return here to create your connection code.'); }
        })}>Review setup for this Mac</button>
      </div>}
      {setup && !setup.available && <p className={styles.notice}>Connect this Mac to your home network, then refresh the connection.</p>}
      {setup && !setup.needsSetup && !transport?.listening && <button className={styles.primary} disabled={busy} onClick={() => act(async api => { await api.startTransport(); })}>Enable iPhone connection</button>}
      <div className={styles.actions}>
        <button className={styles.primary} disabled={busy || !ready} onClick={() => act(async api => {
          const value = await api.createConnectionCode(); setNow(Date.now());
          setOffer({...value, deviceIDs: state?.devices.map(device => device.id) ?? []});
        })}>{offer ? 'Create a new code' : 'Create connection code'}</button>
        <button className={styles.secondary} disabled={busy} onClick={() => act(async () => {})}>Refresh connection</button>
      </div>
      {offer && <div className={styles.codePanel}>
        <div className={styles.codeHeading}><strong>Connection code</strong><span role="status">{expired ? 'Expired — create a new code' : `Expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}</span></div>
        {!expired && <textarea aria-label="Connection code" className={styles.code} readOnly value={offer.code} rows={4} spellCheck={false} />}
        <div className={styles.actions}>
          <button className={styles.primary} disabled={busy || expired} onClick={() => act(async api => { await api.copyConnectionCode(); setMessage('Code copied. Paste it into Flyx on your iPhone.'); })}>Copy connection code</button>
          <button className={styles.secondary} disabled={busy} onClick={() => act(async api => { await api.cancelPairing(); setOffer(null); setMessage('Code cancelled. Existing phones stay connected.'); })}>Cancel code</button>
        </div>
        <p className={styles.small}>The code includes the secure Mac address and certificate fingerprint. It expires after two minutes and still requires your approval here. Share it only with the iPhone you want to connect.</p>
      </div>}
      {state?.pending && <div className={styles.notice} role="status">
        <strong>{state.pending.name} wants to connect</strong>
        <p>Allow this iPhone to browse Flyx and control Mac playback?</p>
        <label><input type="checkbox" checked={downloads} onChange={event => setDownloads(event.target.checked)} /> Allow Mac download management</label>
        <div className={styles.actions}>
          <button className={styles.primary} disabled={busy} onClick={() => act(async api => { await api.approve(state.pending!.id, downloads); setOffer(null); })}>Approve iPhone</button>
          <button className={styles.secondary} disabled={busy} onClick={() => act(async api => { await api.reject(state.pending!.id); setOffer(null); })}>Decline</button>
        </div>
      </div>}
      {!!state?.devices.length && <div className={styles.devices}><h3>Remembered iPhones</h3><ul>{state.devices.map(device => <li key={device.id}>
        <div className={styles.deviceHeading}><strong>{device.name}</strong><button className={styles.secondary} disabled={busy} onClick={() => act(async api => { await api.revoke(device.id); })}>Revoke access</button></div>
        <DevicePermissions key={`${device.id}:${device.scopes?.join(',')}`} device={device} busy={busy} apply={(watchlist, downloads) => act(async api => { await api.updatePermissions(device.id, watchlist, downloads); })} />
      </li>)}</ul><p className={styles.small}>Remembered access stays on this Mac. Revoking a phone requires it to connect and be approved again.</p></div>}
      {transport?.listening && <details className={styles.details}><summary>Connection details</summary><p>{transport.endpoint}</p><p className={styles.small}>Certificate fingerprint: <code>{transport.pin}</code></p><button className={styles.secondary} disabled={busy} onClick={() => act(async api => { await api.stopTransport(); setOffer(null); })}>Disable remote and revoke access</button></details>}
    </>}
    {message && <p role="status" className={styles.notice}>{message}</p>}
    {error && <p role="alert" className={styles.notice}>{error}</p>}
  </section>;
}

function DevicePermissions({device, busy, apply}: {device: {scopes?: string[]}; busy: boolean; apply: (watchlist: boolean, downloads: boolean) => Promise<void>}) {
  const [watchlist, setWatchlist] = useState(device.scopes?.includes('watchlist.write') ?? false);
  const [downloads, setDownloads] = useState(device.scopes?.includes('downloads.write') ?? false);
  return <div className={styles.permissions}>
    <label><input type="checkbox" checked={watchlist} onChange={event => setWatchlist(event.target.checked)} /> Allow watchlist saving</label>
    <label><input type="checkbox" checked={downloads} onChange={event => setDownloads(event.target.checked)} /> Allow Mac download management</label>
    <button className={styles.secondary} disabled={busy} onClick={() => apply(watchlist, downloads)}>Approve permission changes</button>
  </div>;
}
