// Local, bounded source-preparation timing. Never accept free-form text or URLs.
const phases = new Set(['media-prepare','media-resolved','media-grant','media-first-resource','media-resource-ready','media-resource-error','media-first-chunk','media-chunk-ready','media-chunk-error','media-phone-ready','media-phone-started','media-close','ipc-start','ipc-reply','ipc-timeout','ipc-send-error','renderer-start','fetch-start','fetch-headers','fetch-json','fetch-error','resolve-complete','route-enter','route-abort','route-error','route-response','auth-start','auth-done','auth-timeout','local-start','local-done','metadata-start','metadata-done','extract-start','extract-done']);
const providers = new Set(['local','animex','vidsrc','vidlove','multiembed','videasy']);
const errors = new Set(['PHONE_AUTH_TIMEOUT','PHONE_SOURCE_TIMEOUT','PHONE_MEDIA_UNAVAILABLE','MAC_RENDERER_TIMEOUT','MAC_OPERATION_FAILED','PHONE_FORMAT_UNSUPPORTED','PHONE_MEDIA_EXPIRED']);
const names = new Set(['AbortError','TimeoutError','TypeError','Error','SyntaxError']);
export function preparationID(value) { return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? value.toLowerCase() : undefined; }
/** @param {any} value */
export function safePreparationEvent(value) {
  const requestID = preparationID(value?.requestID);
  if (!requestID || !phases.has(value?.phase)) return undefined;
  /** @type {Record<string, any>} */
  const result = {requestID, phase:value.phase};
  for (const key of ['contentID','season','episode','elapsedMS','probeMS','budgetMS','sourceCount','status']) {
    const number = value[key];
    const maximum = key === 'status' ? 599 : key === 'sourceCount' ? 64 : ['elapsedMS','probeMS','budgetMS'].includes(key) ? 90000 : 2147483647;
    if (Number.isSafeInteger(number) && number >= 0 && number <= maximum) result[key] = number;
  }
  if (['anime','movie','tv'].includes(value.kind)) result.kind = value.kind;
  if (['mp4','hls'].includes(value.format)) result.format=value.format;
  if (providers.has(value.provider)) result.provider = value.provider;
  if (errors.has(value.errorCode)) result.errorCode = value.errorCode;
  if (names.has(value.errorName)) result.errorName = value.errorName;
  for (const key of ['ok','aborted']) if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}
/** @param {{requestID?:unknown, emit?:(event:Record<string, any>)=>void, now?:()=>number}} options */
export function createPreparationTrace({requestID,emit=()=>{},now=Date.now}={}) {
  const id=preparationID(requestID), start=now(); let count=0;
  /** @param {string} phase @param {Record<string, any>} fields */
  return (phase,fields={}) => {
    const elapsedMS=Math.max(0,Math.floor(now()-start));
    if (!id || count>=40 || elapsedMS>90000) return;
    const event=safePreparationEvent({...fields,requestID:id,phase,elapsedMS});
    if (!event) return;
    count++;
    // Observability cannot interrupt or delay source preparation.
    try { emit(event); } catch {}
  };
}
