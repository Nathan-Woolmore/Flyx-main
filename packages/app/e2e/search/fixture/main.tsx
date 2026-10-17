import RemoteHost from "@/lib/remote/RemoteHost";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import MangaPageClient from "@/app/manga/MangaPageClient";
import MangaDetailsClient from "@/app/manga/[id]/MangaDetailsClient";
import SearchPageClient from "@/app/search/SearchPageClient";
import WatchPage from "@/app/watch/page";
import DownloadsClient from "@/components/downloads/DownloadsClient";
import AnimeDetailsClient from "@/app/anime/[malId]/AnimeDetailsClient";
import "@/app/globals.css";

/** Real search UI, card and slider; the Next router and movie details destination are test adapters; Anime details is real. */
function Fixture() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  useEffect(() => {
    if (path !== "/search") window.scrollTo(0, 0);
  }, [path]);
  return path === "/manga" ? (
    <MangaPageClient />
  ) : /^\/manga\/[^/]+$/.test(path) ? (
    <MangaDetailsClient mangaId={path.split("/")[2]} />
  ) : path === "/watch" ? (
    <WatchPage />
  ) : path === "/downloads" ? (
    <DownloadsClient />
  ) : path === "/search" ? (
    <SearchPageClient initialSearch={window.location.search} />
  ) : /^\/anime\/\d+$/.test(path) ? (
    <AnimeDetailsClient malId={Number(path.split("/").at(-1))} />
  ) : (
    <main style={{ padding: 32 }}>
      <h1>Title details</h1>
      <button type="button" onClick={() => window.history.back()}>
        ← Back
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<><RemoteHost /><Fixture /></>);
