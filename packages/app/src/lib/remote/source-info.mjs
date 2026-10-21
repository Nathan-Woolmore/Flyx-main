// Source provenance only. Never copy a media URL, headers or signing query.
const label = (value, limit) => {
  if (typeof value !== 'string' || /[:/?=&\\\x00-\x1f]|[A-Za-z0-9_-]{40,}/.test(value)) return undefined;
  return value.trim().slice(0, limit) || undefined;
};
export function playbackSourceInfo(source = {}, {provider, fallback, identity} = {}) {
  let localID;
  try {
    const url = new URL(source.url, 'http://flyx.local');
    if (url.pathname === '/api/stream/local' && /^[a-f0-9-]{36}$/i.test(url.searchParams.get('id') ?? '')) localID = url.searchParams.get('id');
  } catch {}
  const name = label(source.provider ?? provider, 60);
  const origin = localID || name === 'local' ? 'download' : name && !['auto', 'Source', 'Mac'].includes(name) ? 'provider' : 'unknown';
  let selection;
  try {
    const [kind, rawID, rawSeason, rawEpisode] = JSON.parse(identity);
    const contentID = Number(rawID), season = Number(rawSeason), episode = Number(rawEpisode);
    if (['movie', 'tv', 'anime'].includes(kind) && Number.isSafeInteger(contentID) && contentID > 0 && Number.isSafeInteger(season) && season >= 0 && Number.isSafeInteger(episode) && episode > 0) selection = {kind, contentID, season, episode};
  } catch {}
  return {origin, provider:origin === 'download' ? 'local' : name, quality:label(source.quality, 40), qualityBasis:origin === 'download' ? 'requested' : 'advertised', ...(localID ? {downloadID:localID} : {}), ...(selection ? {selection} : {}), ...(['local-unavailable', 'source-failed'].includes(fallback) ? {fallback} : {})};
}
