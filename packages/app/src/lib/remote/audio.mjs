// Each command names the output shown to the user. A Cast transition must
// never turn a TV volume action into a Mac action, or the reverse.
export async function applyRemoteAudio(command,{output,player,cast,snapshot}) {
  if(command.output!==output)throw Object.assign(new Error('Playback output changed'),{code:'PLAYBACK_OUTPUT_CHANGED'});
  if(output==='tv') {
    const result=await cast.control({type:command.type,value:command.value});
    if(!result.ok)throw Object.assign(new Error('TV did not accept audio control'),{code:'PLAYBACK_AUDIO_UNAVAILABLE'});
  }else if(command.type==='volume')player.setVolume(command.value);
  else player.setMuted(command.value);
  return {ok:true,status:await snapshot()};
}
