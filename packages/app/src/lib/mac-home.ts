import { tmdbFetch } from "@/lib/tmdb-server";

export interface HomeTMDBItem {
  id: number;
  title?: string;
  name?: string;
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  vote_average?: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  media_type?: string;
}
interface TMDBList { results?: HomeTMDBItem[] }

// The Mac page and paired iOS Home read these exact same lists and ordering.
export const MAC_HOME_FEEDS = [
  { id:"trending-movies", kind:"movie", title:"Top 10 this week", subtitle:"Movies · TMDB weekly trending", path:"/trending/movie/week", ranked:true },
  { id:"popular-movies", kind:"movie", title:"Popular now", subtitle:"Movies · TMDB popularity", path:"/movie/popular", ranked:false },
  { id:"top-rated-movies", kind:"movie", title:"Top rated movies", subtitle:"TMDB community ratings", path:"/movie/top_rated", ranked:false },
  { id:"trending-tv", kind:"tv", title:"Trending TV", subtitle:"Series · TMDB weekly trending", path:"/trending/tv/week", ranked:false },
  { id:"now-playing", kind:"movie", title:"Now playing", subtitle:"TMDB now-playing movies", path:"/movie/now_playing", ranked:false },
] as const;

// TV uses the same weekly Home and popular Browse endpoints as the Mac.
export const MAC_TV_HOME_FEEDS = [
  MAC_HOME_FEEDS[3],
  {id:"popular-tv",kind:"tv",title:"Popular series",subtitle:"Discover your next series",path:"/tv/popular?page=1",ranked:false},
] as const;
type HomeFeed = {readonly path:string};
export async function loadMacHomeLists(feeds:readonly HomeFeed[]=MAC_HOME_FEEDS) {
  return Promise.all(feeds.map(feed => tmdbFetch<TMDBList>(feed.path)));
}
