export const playbackMessages={
  CAST_CONNECT_FAILED:'The Mac could not connect to the selected TV. Keep it awake on the same network and retry.',
  CAST_LOAD_FAILED:'The TV could not load this source. Try another source or quality; the original output is retained.',
  CAST_REQUEST_REJECTED:'The TV rejected the Cast request. Refresh receivers and retry.',
  CAST_SILENT_UNCONFIRMED:'The TV did not confirm the existing mute and zero-volume policy. No media was loaded.',
  CAST_READY_TIMEOUT:'The TV connected but did not finish preparing this source in time. The original output is retained.',
  MAC_RENDERER_TIMEOUT:'The Mac took too long to prepare the destination. Keep Flyx open and retry.',
  MAC_OPERATION_FAILED:'The Mac could not prepare the current playback source. Reopen its controls and retry.',

  TRANSFER_CANCELLED:'Playback switching was cancelled. The original session is retained.',
  TRANSFER_EXPIRED:'This playback switch expired. Choose the destination again.',
  TRANSFER_BUSY:'Another playback switch is still in progress. Retry shortly.',
  TRANSFER_INVALID:'The playback switch was not accepted.',
  TRANSFER_NOT_READY:'The destination is not ready for playback.',
  TRANSFER_UNSUPPORTED:'This source or destination is not supported for transfer.',
  TRANSFER_ORIGIN_CHANGED:'The original title or playback session changed. Refresh before switching.',
  TRANSFER_DESTINATION_CHANGED:'The destination session changed. The original session is retained.',
  TRANSFER_DESTINATION_BUSY:'The destination is playing a different title. Stop it before switching.',
  TRANSFER_DESTINATION_UNCONFIRMED:'The destination did not confirm the position and playback state.',
  TRANSFER_ROLLBACK_UNCONFIRMED:'The switch could not be confirmed or fully restored. Check both outputs before retrying.',

  PHONE_SOURCES_EXHAUSTED:'No remaining compatible source could play. Choose another source or return to the Mac.',
  PHONE_FORMAT_UNSUPPORTED:'Use compatible MP4 or clear on-demand HLS. Encrypted/DRM streams, live HLS and other containers are unsupported.',
  PHONE_MEDIA_UNAVAILABLE:'The Mac could not prepare this source for the iPhone. Keep it open and retry.',
  PHONE_MEDIA_EXPIRED:'Phone playback access expired. Prepare the title again from the Mac.',
  PHONE_TITLE_CHANGED:'The title or episode changed on the Mac. Return to the Remote and prepare it again.',

  PLAYBACK_OUTPUT_CHANGED:'Playback output changed. Refresh the remote before adjusting audio.',
  PLAYBACK_AUDIO_UNAVAILABLE:'This output did not accept the audio change. Retry from its controls.',
  PLAYBACK_AUDIO_LOCKED:'Audio changes are locked by the Mac silent playback setting.',
};
export function playbackFailure(code){return Object.assign(new Error(playbackMessages[code]??'Playback control unavailable'),{code});}
