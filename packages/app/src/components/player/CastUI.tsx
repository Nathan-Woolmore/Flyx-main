'use client';

import { useEffect, useRef, useState } from 'react';
import type { DesktopCastPickerState } from '@/lib/desktop-cast';
import styles from './CastUI.module.css';
import { formatTime } from './stream-proxy';
import { IconPause, IconPlay } from './icons';

export function IconCast({ size = 22, active = false }: { size?: number; active?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M1 18v3h3c0-1.66-1.34-3-3-3z" />
      <path d="M1 14v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7z" />
      <path d="M1 10v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z" />
      <path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z" />
      {active && <path d="M5 7v2h12v8h-4v2h6V7z" opacity="0.35" />}
    </svg>
  );
}

export function IconHelp({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

interface CastButtonProps {
  isCasting?: boolean;
  isConnected?: boolean;
  onClick: () => void;
  className?: string;
  tip?: string;
}

export function CastButton({
  isCasting,
  isConnected,
  onClick,
  className = '',
  tip,
}: CastButtonProps) {
  const active = !!(isCasting || isConnected);
  return (
    <button
      type="button"
      className={`${styles.castBtn} ${active ? styles.active : ''} ${isCasting ? styles.casting : ''} ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      data-tip={tip || (active ? 'Stop casting' : 'Cast to TV')}
      aria-label={active ? 'Stop casting' : 'Cast to TV'}
    >
      <IconCast active={active} />
    </button>
  );
}

interface CastOverlayProps {
  title: string;
  subtitle?: string;
  deviceName?: string | null;
  currentTime?: number;
  duration?: number;
  isPlaying?: boolean;
  onPlayPause?: () => void;
  onSeek?: (time: number) => void;
  onStop: () => void;
  volume?: number;
  isMuted?: boolean;
  onVolume?: (volume: number) => void;
  onMute?: () => void;
}

export function CastOverlay({
  title,
  subtitle,
  deviceName,
  currentTime = 0,
  duration = 0,
  isPlaying = false,
  onPlayPause,
  onSeek,
  onStop,
  volume = 1,
  isMuted = false,
  onVolume,
  onMute,
}: CastOverlayProps) {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className={styles.overlay} onClick={(e) => e.stopPropagation()}>
      <div className={styles.overlayInner}>
        <div className={styles.castBadge}>
          <IconCast active size={18} />
          Casting{deviceName ? ` · ${deviceName}` : ' to TV'}
        </div>
        <h2 className={styles.overlayTitle}>{title || 'Now playing'}</h2>
        {subtitle && <p className={styles.overlaySub}>{subtitle}</p>}

        {duration > 0 && (
          <div className={styles.progress}>
            <div
              className={styles.progressBar}
              onClick={(e) => {
                if (!onSeek) return;
                const rect = e.currentTarget.getBoundingClientRect();
                const pos = (e.clientX - rect.left) / rect.width;
                onSeek(Math.max(0, Math.min(1, pos)) * duration);
              }}
              role="slider"
              aria-valuenow={currentTime}
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-label="Cast seek"
            >
              <div className={styles.progressFill} style={{ width: `${progress}%` }} />
            </div>
            <div className={styles.progressTime}>
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
        )}

        <div className={styles.controls}>
          {onPlayPause && (
            <button type="button" className={styles.controlBtn} onClick={onPlayPause} aria-label={isPlaying ? 'Pause' : 'Play'}>
              {isPlaying ? <IconPause size={26} /> : <IconPlay size={26} />}
            </button>
          )}
          <button type="button" className={styles.stopBtn} onClick={onStop}>
            Stop casting
          </button>
        </div>
        {onVolume && (
          <div className={styles.controls}>
            <button type="button" className={styles.controlBtn} onClick={onMute} aria-label={isMuted ? 'Unmute TV' : 'Mute TV'}>
              {isMuted ? 'Unmute' : 'Mute'}
            </button>
            <input type="range" min={0} max={1} step={0.05} value={volume}
              aria-label="TV volume" onChange={(event) => onVolume(Number(event.target.value))} />
          </div>
        )}
      </div>
    </div>
  );
}

export function DesktopCastPicker({ picker }: { picker: DesktopCastPickerState }) {
  const [address, setAddress] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!picker.open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    return () => { previous?.focus(); };
  }, [picker.open]);
  if (!picker.open) return null;
  return (
    <div className={styles.pickerBackdrop} onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget) picker.cancel(); }}>
      <div ref={dialogRef} className={styles.picker} role="dialog" aria-modal="true" aria-labelledby="flyx-cast-picker-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') { event.preventDefault(); picker.cancel(); }
          if (event.key === 'Tab') {
            const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
            if (!controls?.length) return;
            const first = controls[0], last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
          }
        }}>
        <div className={styles.pickerHeading}>
          <h2 id="flyx-cast-picker-title">Cast movie to TV</h2>
          <button type="button" className={styles.controlBtn} onClick={picker.cancel} aria-label="Close TV picker">Close</button>
        </div>
        <p>The TV plays the movie directly. Casting starts muted. Keep Flyx open and LAN sharing enabled.</p>
        <div aria-live="polite">
          {picker.connecting ? 'Connecting to TV…' : picker.discovering ? 'Searching your home network…' : !picker.devices.length ? 'No Google Cast TVs found. Wake the TV and check that it uses the same home network.' : 'Choose a TV'}
        </div>
        <div className={styles.deviceList}>
          {picker.devices.map((device) => (
            <button key={device.id} type="button" className={styles.device} disabled={picker.connecting}
              onClick={() => picker.select({ id: device.id })}>
              <IconCast size={22} /><span><strong>{device.name}</strong><small>{device.model || 'Google Cast'} · {device.address}</small></span>
            </button>
          ))}
        </div>
        <button type="button" className={styles.stopBtn} disabled={picker.discovering || picker.connecting} onClick={picker.refresh}>Search again</button>
        <form className={styles.manualAddress} onSubmit={(event) => { event.preventDefault(); if (address.trim()) picker.select({ address: address.trim() }); }}>
          <label htmlFor="flyx-cast-ip">TV not listed? Enter its IP address</label>
          <div><input id="flyx-cast-ip" value={address} onChange={(event) => setAddress(event.target.value)}
            placeholder="192.168.1.50" autoComplete="off" inputMode="decimal" disabled={picker.connecting} />
            <button type="submit" className={styles.stopBtn} disabled={picker.connecting || !address.trim()}>Connect</button></div>
          <small>Find the private IPv4 address in the TV’s network settings. Google Cast must be enabled.</small>
        </form>
        {picker.error && <p className={styles.pickerError} role="alert">{picker.error}</p>}
      </div>
    </div>
  );
}

export function CastErrorBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.errorBox} role="alert">
      <strong>Casting issue</strong>
      {message}
      <div>
        <button type="button" className={styles.errorDismiss} onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
