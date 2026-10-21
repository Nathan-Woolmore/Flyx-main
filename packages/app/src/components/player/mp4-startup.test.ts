import { describe, expect, it, vi } from 'vitest';
import { Mp4MetadataDeadline, handleMp4Failure } from './mp4-startup';

function deadline(proxy = true, initial = 15000) {
  let time = 0;
  const value = new Mp4MetadataDeadline(initial, proxy, () => time);
  return { value, at: (next: number) => { time = next; } };
}
describe('bounded MP4 metadata grace', () => {
  it('retains the ordinary startup wait', () => {
    const d = deadline(); d.at(5000); expect(d.value.nextWaitMs()).toBe(10000);
  });
  it('fails at the original deadline if no data arrived', () => {
    const d = deadline(); d.at(15000); expect(d.value.nextWaitMs()).toBeNull();
  });
  it('extends a proxied load only while data progress stays recent', () => {
    const d = deadline(); d.at(13000); d.value.progress(); d.at(15000);
    expect(d.value.nextWaitMs()).toBe(3000);
    d.at(19001); expect(d.value.nextWaitMs()).toBeNull();
  });
  it('caps a trickling source at 45 seconds', () => {
    const d = deadline(); d.at(44000); d.value.progress();
    expect(d.value.nextWaitMs()).toBe(1000);
    d.at(45000); d.value.progress(); expect(d.value.nextWaitMs()).toBeNull();
  });
  it('does not extend a direct or disconnected source', () => {
    const d = deadline(false); d.at(14000); d.value.progress(); d.at(15000);
    expect(d.value.nextWaitMs()).toBeNull();
  });
  it('keeps reduced failure timeouts but permits actual data progress', () => {
    const d = deadline(true, 5000); d.at(4500); d.value.progress(); d.at(5000);
    expect(d.value.nextWaitMs()).toBe(3000);
  });
});
describe('explicit quality failure', () => {
  it('never silently replaces a failed manually chosen HD version', () => {
    const manual = vi.fn(), fallback = vi.fn();
    handleMp4Failure({ explicitChoice: { url: 'hd', label: '1080p' }, failedUrl: 'hd',
      onManualFailure: manual, onAutomaticFailure: fallback });
    expect(manual).toHaveBeenCalledWith('1080p');
    expect(fallback).not.toHaveBeenCalled();
  });
  it('retains bounded automatic fallback for automatic source choice', () => {
    const manual = vi.fn(), fallback = vi.fn();
    handleMp4Failure({ explicitChoice: null, failedUrl: 'auto', onManualFailure: manual, onAutomaticFailure: fallback });
    expect(fallback).toHaveBeenCalledOnce(); expect(manual).not.toHaveBeenCalled();
  });
  it('does not apply an old explicit choice to a different source', () => {
    const fallback = vi.fn();
    handleMp4Failure({ explicitChoice: { url: 'old', label: '1080p' }, failedUrl: 'new',
      onManualFailure: vi.fn(), onAutomaticFailure: fallback });
    expect(fallback).toHaveBeenCalledOnce();
  });
});
