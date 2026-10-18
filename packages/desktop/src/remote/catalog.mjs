const kinds = new Set(['movie', 'tv', 'anime', 'manga']);
const numericID = value => /^[1-9][0-9]{0,9}$/.test(String(value));
export function catalogFailure(code){return Object.assign(new Error('Catalogue request failed'),{code});}
export const catalogMessages={DOWNLOAD_TRASH_UNCONFIRMED:"Mac Trash did not return confirmation. Check Trash before retrying; the download record was kept.",DOWNLOAD_MISSING:"The saved file is missing. The download record was kept.",DOWNLOAD_IN_USE:"This file is open. Stop playback and close it on your Mac, then retry.",DOWNLOAD_CHANGED:"The download or saved file changed. Refresh before trying again.",DOWNLOAD_TRASH_FAILED:"Could not move this file to Mac Trash. The download record was kept.",DOWNLOAD_HISTORY_FAILED:"The file is in Mac Trash, but its list record could not be saved. Remove it from the list after checking Trash.",MANGA_UNAVAILABLE:"Chapter pages are unavailable. Retry this chapter.",MANGA_EXPIRED:"Reopen this chapter to refresh its page access.",WATCHLIST_ACCOUNT_REQUIRED:'Sign in to Flyx on your Mac to use its watchlist.',WATCHLIST_UNAVAILABLE:'The Mac watchlist is unavailable. Retry shortly.',CATALOG_NOT_FOUND:'This title or season is no longer available. Choose another or retry.',CATALOG_RATE_LIMITED:'The catalogue provider is busy. Wait a moment and retry.',CATALOG_TIMEOUT:'The catalogue provider took too long. Retry this title.',CATALOG_SESSION_REQUIRED:'Open Flyx on your Mac and retry the catalogue request.',CATALOG_UNAVAILABLE:'The catalogue provider is unavailable. Retry shortly.'};
export class CatalogRequestError extends Error { constructor(message){super(message);this.name='CatalogRequestError';} }
export function catalogPath({kind, query = '', page = 1, id, genre = '', yearFrom, yearTo, minRating = 0, sort = 'popularity', minVotes}, details = false) {
  if (!kinds.has(kind) || typeof query !== 'string' || query.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 500) throw new CatalogRequestError('Invalid catalogue request');
  query=query.trim();
  const year=new Date().getFullYear();
  if(minVotes!==undefined&&(!Number.isSafeInteger(minVotes)||minVotes<0||minVotes>1000000))throw new CatalogRequestError('Invalid minimum rating votes');
  if(typeof genre!=='string'||!/^$|^[1-9][0-9]{0,5}$/.test(genre)||![undefined,...Array.from({length:year-1899},(_,i)=>i+1900)].includes(yearFrom)||![undefined,...Array.from({length:year-1899},(_,i)=>i+1900)].includes(yearTo)||(yearFrom??1900)>(yearTo??year)||!Number.isFinite(minRating)||minRating<0||minRating>10||!['relevance','popularity','rating','release_date'].includes(sort))throw new CatalogRequestError('Invalid catalogue filters');
  if (details && (kind === 'manga' ? !/^[a-zA-Z0-9._-]{1,300}$/.test(String(id)) : !numericID(id))) throw new Error('Invalid content ID');
  const q = new URLSearchParams(); let path;
  if (kind === 'manga') {
    if(!details&&(genre||yearFrom!==undefined||yearTo!==undefined||minRating||page!==1||!['relevance','popularity','release_date'].includes(sort)))throw new CatalogRequestError('Manga supports title search and popular/latest feeds; these filters are unavailable');
    path = details ? '/api/manga/details' : query ? '/api/manga/search' : '/api/manga/popular';
    if (details) q.set('id', id); else { q.set('q', query); q.set('page', String(page)); q.set('limit', '40');if(!query)q.set('type',sort==='release_date'?'latest':'popular'); }
  } else if (kind === 'anime') {
    path = '/api/anime/jikan';
    const params=new URLSearchParams({page:String(page),limit:'20',sfw:'true'});
    if(query)params.set('q',query);if(genre)params.set('genres',genre);
    if(yearFrom)params.set('start_date',`${yearFrom}-01-01`);if(yearTo)params.set('end_date',`${yearTo}-12-31`);
    if(minRating)params.set('min_score',String(minRating));
    if(sort!=='relevance'){params.set('order_by',sort==='rating'?'score':sort==='release_date'?'start_date':'members');params.set('sort','desc');}
    q.set('path', details ? `/anime/${id}/full` : `/anime?${params}`);
  } else {
    path = details ? '/api/content/details' : '/api/content/search';
    if (details) { q.set('id', String(id)); q.set('mediaType', kind); }
    else { q.set('type', kind); q.set('q', query); q.set('page', String(page)); q.set('sort',query?'relevance':sort);if(genre)q.set('genre',genre);if(yearFrom)q.set('yearFrom',String(yearFrom));if(yearTo)q.set('yearTo',String(yearTo));if(minRating)q.set('minRating',String(minRating));if(minVotes!==undefined||sort==='rating')q.set('minVotes',String(minVotes??10)); }
  }
  return `${path}?${q}`;
}
function item(value, kind) {
  if(!value||typeof value!=='object')throw catalogFailure('CATALOG_NOT_FOUND');
  const id = value.id ?? value.mal_id;
  if (id == null) throw new Error('Missing catalog ID');
  const image = value.posterPath ?? value.poster_path ?? value.coverImage ?? value.images?.webp?.large_image_url ?? value.images?.jpg?.image_url;
  const backdrop=value.backdrop_path??value.backdropPath;
  const backdropURL=typeof backdrop==='string'?(backdrop.startsWith('/')?`https://image.tmdb.org/t/p/w780${backdrop}`:/^https:\/\//.test(backdrop)?backdrop:null):null;
  const score=Number(value.vote_average??value.rating??value.score);
  const releaseDate=value.release_date??value.first_air_date??value.releaseDate??value.aired?.from??(value.year?String(value.year):null);
  const votes=value.vote_count??value.voteCount??value.scored_by;
  return {backdropURL,voteCount:Number.isSafeInteger(votes)&&votes>=0?votes:null,rating:Number.isFinite(score)&&score>0&&score<=10?score:null,releaseDate:typeof releaseDate==='string'?releaseDate:null, id: String(id), kind, title: value.title ?? value.name ?? 'Untitled', overview: value.overview ?? value.description ?? value.synopsis ?? '', posterURL: typeof image === 'string' ? (image.startsWith('/') ? `https://image.tmdb.org/t/p/w500${image}` : /^https:\/\//.test(image) ? image : null) : null };
}
export function movieTrailer(data) {
 const candidates=(Array.isArray(data.videos?.results)?data.videos.results:[]).filter(v=>v.site==='YouTube'&&v.type==='Trailer'&&typeof v.key==='string'&&/^[A-Za-z0-9_-]{11}$/.test(v.key));
 // This catalogue requests en-US. Prefer official, language-matched trailers.
 candidates.sort((a,b)=>(Number(b.iso_639_1==='en')*2+Number(b.official===true))-(Number(a.iso_639_1==='en')*2+Number(a.official===true)));
 const v=candidates[0];return v?{videoID:v.key,title:String(v.name??'Trailer').slice(0,200)}:null;
}
function metadataFor(data,kind){
 const rows=[];const add=(label,value)=>{if(value!==undefined&&value!==null&&value!==''&&value!==0)rows.push({label,value:String(value)});};
 const names=value=>Array.isArray(value)?value.map(v=>typeof v==='string'?v:v.name).filter(Boolean).join(', '):undefined;
 add('Original title',data.original_title??data.original_name??data.title_japanese);add('Type',data.type??(kind==='movie'?'Movie':kind==='tv'?'TV':undefined));add('Status',data.status);
 add('Release date',data.release_date??data.first_air_date??data.aired?.string??data.year);add('Runtime',data.runtime?data.runtime+' min':data.episode_run_time?.[0]?data.episode_run_time[0]+' min':data.duration);
 add('Episodes',data.number_of_episodes??(typeof data.episodes==='number'?data.episodes:undefined));add('Seasons',data.number_of_seasons);add('Genres',names(data.genres));add('Studios',names(data.production_companies??data.studios));add('Original language',data.original_language);
 add('Director',data.credits?.crew?.filter(v=>v.job==='Director').map(v=>v.name).join(', '));add('Creators',names(data.created_by));add('Cast',data.credits?.cast?.slice(0,12).map(v=>v.name).join(', '));
 add('Producers',names(data.producers));add('Licensors',names(data.licensors));add('Themes',names(data.themes));add('Demographics',names(data.demographics));add('English title',data.title_english);add('Content classification',data.contentRating);
 add('Source',kind==='manga'?'WeebCentral':kind==='movie'||kind==='tv'?'TMDB':data.source);add('Content rating',data.rating&&typeof data.rating==='string'?data.rating:undefined);add('Premiered',data.season&&data.year?data.season+' '+data.year:undefined);add('Author',data.author);add('Artist',data.artist);add('Year',data.year);add('Total chapters',data.totalChapters);add('Tagline',data.tagline);
 return rows;
}
export function normalizeCatalog(body, kind, details = false, page = 1) {
  if (!body || body.error || body.success === false) throw catalogFailure('CATALOG_UNAVAILABLE');
  const data = body.data;
  if (details) {
    const content = item(data, kind);
    const seen=new Set();const seasons=(Array.isArray(data.seasons)?data.seasons:[]).filter(s=>{const n=s.seasonNumber??s.season_number;return Number.isSafeInteger(n)&&n>=0&&n<=1000&&!seen.has(n)&&seen.add(n);}).map(s=>({number:s.seasonNumber??s.season_number,episodes:(Array.isArray(s.episodes)?s.episodes:[]).filter(e=>Number.isSafeInteger(e.episodeNumber??e.episode_number)&&(e.episodeNumber??e.episode_number)>0).map(e=>({number:e.episodeNumber??e.episode_number,title:String(e.name??e.title??'Episode '+(e.episodeNumber??e.episode_number))}))}));
    return {...content,trailer:kind==='movie'?movieTrailer(data):null,metadata:metadataFor(data,kind),seasons,episodeCount:kind==='anime'&&Number.isSafeInteger(data.episodes)&&data.episodes>0?data.episodes:null,selectedSeason:body.selectedSeason??null,seasonError:body.seasonError??null,chapters:kind==='manga'&&Array.isArray(data.chapters)?data.chapters.filter(c=>typeof c.id==='string'&&Number.isFinite(c.number)&&c.number>=0).map(c=>({id:c.id,number:c.number,title:String(c.title??'Chapter '+c.number),language:c.language??'unknown',edition:c.edition??'unlabeled:'+c.id})).sort((a,b)=>a.number-b.number):[]};
  }
  if (!Array.isArray(data)) throw new Error('Invalid catalog response');
  const seen=new Set();const items=data.map(v=>item(v,kind)).filter(v=>{const key=`${v.kind}:${v.id}`;if(seen.has(key))return false;seen.add(key);return true;});
  const next=kind==='manga'?null:body.nextPage ?? (body.pagination?.has_next_page ? (body.pagination.current_page??page)+1:null);
  return { items, nextPage:Number.isSafeInteger(next)&&next>page&&next<=500?next:null };
}
export function createCatalog(request) {
  return async (query, details = false) => {
    let body;
    try { body=await request(catalogPath(query,details)); }
    catch(error){if(error.name==='CatalogRequestError'||catalogMessages[error.code])throw error;throw catalogFailure('CATALOG_UNAVAILABLE');}
    if (details && query.kind === 'tv' && Array.isArray(body.data?.seasons)) {
      const seasons=body.data.seasons.filter(s=>Number.isSafeInteger(s.seasonNumber??s.season_number));
      const first=seasons.find(s=>(s.seasonNumber??s.season_number)>0)??seasons[0];
      const number=query.season??first?.seasonNumber??first?.season_number;
      if(number!==undefined) {
        const selected=seasons.find(s=>(s.seasonNumber??s.season_number)===number);
        if(!Number.isSafeInteger(number)||number<0||number>1000||!selected)throw new CatalogRequestError('That season is unavailable. Choose an available season.');
        body.selectedSeason=number;
        if(!Array.isArray(selected.episodes)) {
          try {
            const response=await request('/api/content/season?'+new URLSearchParams({id:String(query.id),season:String(number)}));
            const season=response.data??response;
            if(response.error||!Array.isArray(season.episodes))throw catalogFailure('CATALOG_UNAVAILABLE');
            body.data.seasons=seasons.map(s=>(s.seasonNumber??s.season_number)===number?{...s,episodes:season.episodes}:s);
          } catch(error) {body.seasonError=catalogMessages[error.code]??'Episode details are temporarily unavailable. Retry this season.';}
        }
      }
    }
    const result=normalizeCatalog(body,query.kind,details,query.page??1);
    if(!details&&query.kind!=='manga'){const minimum=query.minVotes??(query.sort==='rating'?10:0);if(minimum>0)result.items=result.items.filter(item=>Number.isSafeInteger(item.voteCount)&&item.voteCount>=minimum);}
    return result;
  };
}
