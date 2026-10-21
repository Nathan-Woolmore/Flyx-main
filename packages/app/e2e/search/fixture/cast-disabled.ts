// No discovery, transport, media commands or browser Cast SDK in isolated player tests.
const unused = () => {
  throw new Error("Cast must not be invoked in this fixture");
};
export function useCast() {
  return {
    isCasting: false,
    isConnected: false,
    isMuted: true,
    lastError: null,
    deviceName: "",
    currentTime: 0,
    duration: 0,
    volume: 0,
    playerState: "IDLE",
    requestSession: unused,
    disconnect: unused,
    loadMedia: unused,
    seek: unused,
    setVolume: unused,
    toggleMute: unused,
    playOrPause: unused,
  };
}
