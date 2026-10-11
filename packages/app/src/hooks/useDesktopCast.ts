'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getDesktopCastBridge, type DesktopCastResult, type DesktopCastState, type DesktopCastDevice, type DesktopCastPickerState } from '@/lib/desktop-cast';
import { resolveCastStreamUrl } from '@/lib/external-player-client';
import type { CastMedia, UseCastOptions } from './useCast';

const EMPTY: DesktopCastState = { isConnected: false, isCasting: false, deviceName: null,
  currentTime: 0, duration: 0, volume: 1, isMuted: false, playerState: 'IDLE', lastError: null };

export function useDesktopCast(options: UseCastOptions) {
  const [bridge] = useState(getDesktopCastBridge);
  const [state, setState] = useState<DesktopCastState>(EMPTY);
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DesktopCastDevice[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const pending = useRef<((connected: boolean) => void) | null>(null);
  const active = useRef(true);
  const discoveryGeneration = useRef(0);
  const pickerGeneration = useRef(0);
  const lastState = useRef<DesktopCastState>(EMPTY);
  const callbacks = useRef(options);
  useEffect(() => { callbacks.current = options; }, [options]);

  const report = useCallback((message: string) => {
    if (!active.current) return;
    setState((previous) => ({ ...previous, lastError: message }));
    callbacks.current.onError?.(message);
  }, []);
  const checked = useCallback(async (operation: Promise<DesktopCastResult>) => {
    try {
      const result = await operation;
      if (!result.ok) report(result.error || 'The TV could not complete the Cast request.');
      return result.ok;
    } catch { report('Flyx could not reach its Cast connection. Choose the TV again to reconnect.'); return false; }
  }, [report]);

  useEffect(() => {
    active.current = true;
    if (!bridge) return;
    const discoveryEpoch = discoveryGeneration;
    const pickerEpoch = pickerGeneration;
    const apply = (next: DesktopCastState) => {
      if (!active.current) return;
      const previous = lastState.current;
      lastState.current = next; setState(next);
      // Pause local playback only when media has actually loaded on the TV.
      if (next.isCasting && !previous.isCasting) callbacks.current.onConnect?.();
      if (previous.isConnected && !next.isConnected) callbacks.current.onDisconnect?.();
      if (next.lastError && next.lastError !== previous.lastError) callbacks.current.onError?.(next.lastError);
    };
    const unsubscribe = bridge.onState(apply);
    // Do not overwrite a newer event with the initial asynchronous snapshot.
    let received = false;
    const unsubscribeMarker = bridge.onState(() => { received = true; });
    bridge.getState().then((next) => { if (!received) apply(next); }).catch(() => report('Could not read the Cast connection.'));
    return () => {
      active.current = false; ++discoveryEpoch.current; ++pickerEpoch.current;
      pending.current?.(false); pending.current = null;
      unsubscribe(); unsubscribeMarker();
      void bridge.cancelDiscovery().catch(() => {});
      void bridge.disconnect().catch(() => {});
    };
  }, [bridge, report]);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    const generation = ++discoveryGeneration.current;
    setDiscovering(true); setPickerError(null);
    try {
      const result = await bridge.discover();
      if (!active.current || generation !== discoveryGeneration.current) return;
      setDevices(result.devices || []);
      if (!result.ok) setPickerError(result.error || 'TV discovery failed. Try the TV’s IP address.');
    } catch { if (active.current && generation === discoveryGeneration.current) setPickerError('TV discovery failed. Try the TV’s IP address.'); }
    finally { if (active.current && generation === discoveryGeneration.current) setDiscovering(false); }
  }, [bridge]);
  const cancel = useCallback(() => {
    ++pickerGeneration.current; ++discoveryGeneration.current;
    setOpen(false); setDiscovering(false); setConnecting(false);
    pending.current?.(false); pending.current = null;
    void bridge?.cancelDiscovery().catch(() => {});
    void bridge?.disconnect().catch(() => {});
  }, [bridge]);
  const select = useCallback(async (receiver: { id: string } | { address: string }) => {
    if (!bridge || connecting) return;
    const generation = ++pickerGeneration.current;
    setConnecting(true); setPickerError(null);
    try {
      const result = await bridge.connect(receiver);
      if (!active.current || generation !== pickerGeneration.current) return;
      if (result.ok) {
        ++discoveryGeneration.current; setOpen(false); setDiscovering(false);
        pending.current?.(true); pending.current = null;
      } else setPickerError(result.error || 'Could not connect to the TV.');
    } catch { if (active.current && generation === pickerGeneration.current) setPickerError('Could not connect to the TV. Check its network and retry.'); }
    finally { if (active.current && generation === pickerGeneration.current) setConnecting(false); }
  }, [bridge, connecting]);
  const requestSession = useCallback((): Promise<boolean> => {
    if (!bridge) return Promise.resolve(false);
    if (pending.current) return Promise.resolve(false);
    setOpen(true); setPickerError(null);
    const promise = new Promise<boolean>((resolve) => { pending.current = resolve; });
    void refresh(); return promise;
  }, [bridge, refresh]);

  const loadMedia = useCallback(async (media: CastMedia) => {
    if (!bridge) return false;
    if (callbacks.current.videoRef?.current) callbacks.current.videoRef.current.muted = true;
    try {
      const url = await resolveCastStreamUrl(media.source || { url: media.url });
      return await checked(bridge.load({ url, title: media.title, subtitle: media.subtitle,
        contentType: media.contentType || 'application/x-mpegURL', startTime: media.startTime, isLive: media.isLive }));
    } catch (err) {
      report(err instanceof Error ? err.message : 'Could not prepare the stream for the TV.');
      await bridge.disconnect().catch(() => {}); return false;
    }
  }, [bridge, checked, report]);
  const disconnect = useCallback(() => {
    if (bridge) void checked(bridge.disconnect());
  }, [bridge, checked]);
  const command = useCallback((type: 'play' | 'pause' | 'seek' | 'volume' | 'mute', value?: number | boolean) => {
    if (bridge) void checked(bridge.control({ type, value }));
  }, [bridge, checked]);
  const playOrPause = useCallback(() => command(lastState.current.playerState === 'PLAYING' ? 'pause' : 'play'), [command]);
  const seek = useCallback((time: number) => command('seek', time), [command]);
  const setVolume = useCallback((volume: number) => command('volume', volume), [command]);
  const toggleMute = useCallback(() => command('mute', !lastState.current.isMuted), [command]);
  const picker: DesktopCastPickerState = { open, discovering, connecting, devices, error: pickerError,
    refresh: () => { void refresh(); }, select: (receiver) => { void select(receiver); }, cancel };
  return { ...state, isDesktop: !!bridge, picker, requestSession, loadMedia, disconnect,
    stop: disconnect, playOrPause, seek, setVolume, toggleMute };
}
