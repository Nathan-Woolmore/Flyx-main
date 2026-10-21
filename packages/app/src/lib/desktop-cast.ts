export interface DesktopCastDevice { id: string; address: string; name: string; model?: string }
export interface DesktopCastState {
  isConnected: boolean; isCasting: boolean; deviceName: string | null;
  connectionID?:number;mediaSessionID?:number;deviceID?:string;
  currentTime: number; duration: number; volume: number; isMuted: boolean;
  playerState: 'IDLE' | 'PLAYING' | 'PAUSED' | 'BUFFERING'; lastError: string | null;
}
export interface DesktopCastResult { ok: boolean; error?: string; devices?: DesktopCastDevice[];mediaSessionID?:number;connectionID?:number }
export interface DesktopCastPickerState {
  open: boolean; discovering: boolean; connecting: boolean; devices: DesktopCastDevice[]; error: string | null;
  refresh: () => void; select: (receiver: { id: string } | { address: string }) => void; cancel: () => void;
}
interface DesktopCastBridge {
  discover: () => Promise<DesktopCastResult>; cancelDiscovery: () => Promise<DesktopCastResult>;
  getState: () => Promise<DesktopCastState>;
  connect: (receiver: { id: string } | { address: string }) => Promise<DesktopCastResult>;
  load: (media: { url: string; title: string; subtitle?: string; contentType: string; startTime?: number; autoplay?: boolean; isLive?: boolean }) => Promise<DesktopCastResult>;
  control: (command: { type: 'play' | 'pause' | 'seek' | 'volume' | 'mute'; value?: number | boolean }) => Promise<DesktopCastResult>;
  disconnect: () => Promise<DesktopCastResult>;
  onState: (callback: (state: DesktopCastState) => void) => () => void;
}
export function getDesktopCastBridge(): DesktopCastBridge | null {
  if (typeof window === 'undefined') return null;
  const desktop = (window as unknown as { flyxDesktop?: { isDesktop?: boolean; cast?: DesktopCastBridge } }).flyxDesktop;
  return desktop?.isDesktop && typeof desktop.cast?.connect === 'function' ? desktop.cast : null;
}
