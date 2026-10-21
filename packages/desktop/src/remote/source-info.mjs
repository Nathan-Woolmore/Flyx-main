// Allowlist the nonsecret provenance crossing the paired Remote boundary.
const label = (value, limit) => typeof value === 'string' && !/[:/?=&\\\x00-\x1f]|[A-Za-z0-9_-]{40,}/.test(value) ? value.trim().slice(0, limit) || undefined : undefined;
export function publicSourceInfo(value) {
  if (!value || typeof value !== 'object') return undefined;
  const origin = ['download', 'provider', 'unknown'].includes(value.origin) ? value.origin : 'unknown';
  const result = {origin, provider:origin === 'download' ? 'local' : label(value.provider, 60), quality:label(value.quality, 40), qualityBasis:['requested', 'advertised'].includes(value.qualityBasis) ? value.qualityBasis : 'advertised'};
  if (/^[a-f0-9-]{36}$/i.test(value.downloadID ?? '') && origin === 'download') result.downloadID = value.downloadID;
  const s = value.selection;
  if (s && ['movie', 'tv', 'anime'].includes(s.kind) && Number.isSafeInteger(s.contentID) && s.contentID > 0 && Number.isSafeInteger(s.season) && s.season >= 0 && Number.isSafeInteger(s.episode) && s.episode > 0) result.selection = {kind:s.kind, contentID:s.contentID, season:s.season, episode:s.episode};
  if (['local-unavailable', 'source-failed'].includes(value.fallback)) result.fallback = value.fallback;
  return result;
}
