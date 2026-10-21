"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import type { MediaItem } from "@/types/media";
import { PageTransition } from "@/components/layout/PageTransition";
import { ContentCard } from "@/components/ContentCard";
import { useAnalytics } from "@/components/analytics/AnalyticsProvider";
import { usePresenceContext } from "@/components/analytics/PresenceProvider";
import { SearchController } from "@/lib/search/controller";
import { fetchSearchPage } from "@/lib/search/client";
import {
  readSearchParameters,
  restoreSearchSnapshot,
  saveSearchSnapshot,
  searchHref,
} from "@/lib/search/state";
import { SearchSidebar } from "./SearchSidebar";

export default function SearchPageClient({ initialSearch }: { initialSearch: string }) {
  const router = useRouter();
  const { trackPageView } = useAnalytics();
  const presence = usePresenceContext();
  const [controller] = useState(
    () =>
      new SearchController(
        readSearchParameters(new URLSearchParams(initialSearch)),
        fetchSearchPage,
      ),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const { query, filters, items: results, loading, error } = state;
  const hasMore = state.nextPage !== null;
  const href = searchHref(state);
  const resultsCurrent = state.resultsHref === href;
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [restoreY, setRestoreY] = useState<number | null>(null);
  const restoring = useRef(false);
  const leaving = useRef(false);
  const scrollY = useRef(0);
  const observerTarget = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const save = () => {
      const snapshot = controller.capture(scrollY.current);
      if (snapshot) {
        try {
          saveSearchSnapshot(sessionStorage, snapshot);
        } catch {
          /* Storage may be disabled. */
        }
      }
    };
    const activate = () => {
      if (window.location.pathname !== "/search") return;
      leaving.current = false;
      const parameters = readSearchParameters(new URLSearchParams(window.location.search));
      let saved = null;
      try {
        saved = restoreSearchSnapshot(sessionStorage, parameters);
      } catch {
        /* Use URL filters. */
      }
      restoring.current = saved !== null;
      scrollY.current = saved?.scrollY ?? 0;
      setRestoreY(saved?.scrollY ?? null);
      controller.activate(parameters, saved);
    };
    const trackScroll = () => {
      if (!restoring.current) scrollY.current = window.scrollY;
    };
    activate();
    window.addEventListener("popstate", activate);
    window.addEventListener("scroll", trackScroll, { passive: true });
    window.addEventListener("pagehide", save);
    return () => {
      if (!leaving.current) save();
      controller.cancel();
      window.removeEventListener("popstate", activate);
      window.removeEventListener("scroll", trackScroll);
      window.removeEventListener("pagehide", save);
    };
  }, [controller]);

  useEffect(() => {
    // Retain Next's history metadata so its Back navigation remains intact.
    window.history.replaceState(window.history.state, "", href);
  }, [href]);

  useEffect(() => {
    trackPageView("/search");
  }, [trackPageView]);
  useEffect(() => {
    presence.setBrowsingContext(query ? `Search: "${query}"` : "Search");
  }, [query, presence.setBrowsingContext]);

  useEffect(() => {
    if (restoreY === null || loading || !resultsCurrent) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        window.scrollTo(0, restoreY);
        scrollY.current = window.scrollY;
        restoring.current = false;
        setRestoreY(null);
      });
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [restoreY, loading, resultsCurrent]);

  useEffect(() => {
    if (!hasMore || loading || error || !results.length || restoring.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !restoring.current) controller.loadMore();
      },
      { threshold: 0.5, rootMargin: "100px" },
    );
    if (observerTarget.current) observer.observe(observerTarget.current);
    return () => observer.disconnect();
  }, [controller, hasMore, loading, error, results.length, restoreY]);

  const handleContentClick = (item: MediaItem) => {
    if (!resultsCurrent) return;
    const snapshot = controller.capture(window.scrollY);
    if (snapshot) {
      try {
        saveSearchSnapshot(sessionStorage, snapshot);
      } catch {
        /* URL filters still work. */
      }
    }
    leaving.current = true;
    window.history.replaceState(window.history.state, "", href);
    const malId = (item as any).mal_id;
    router.push(
      malId
        ? `/anime/${malId}`
        : `/details/${item.id}?type=${item.mediaType === "tv" ? "tv" : "movie"}`,
    );
  };

  return (
    <PageTransition>
      <div className="search-page min-h-screen text-white">
        <div className="page-glow" />
        <div className="search-layout content-container relative pb-20 pt-5 md:pt-8">
          {/* Page intro */}
          <div className="search-page-header page-header mb-5">
            <p className="eyebrow">Discover</p>
            <h1>Search</h1>
            <p className="subtitle">Movies, TV shows, and anime — find anything fast</p>
          </div>

          <div className="search-workspace">
            {/* Mobile Filter Toggle */}
            <button
              className="search-filter-toggle"
              onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M4 21v-7m0-4V3m8 18v-9m0-4V3m8 18v-5m0-4V3M1 14h6m2-6h6m2 8h6" />
              </svg>
              {isSidebarOpen ? "Hide Filters" : "Show Filters"}
            </button>

            {/* Sidebar */}
            <div className={`search-filters-panel ${isSidebarOpen ? "is-open" : ""}`}>
              <SearchSidebar
                filters={filters}
                onFilterChange={(newFilters) => controller.setFilters(newFilters)}
              />
            </div>

            {/* Main Content */}
            <main className="search-results-pane" aria-busy={loading}>
              {/* Search Input Area */}
              <div className="search-input-shell">
                <div className="search-input-icon">
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden
                  >
                    <circle cx="11" cy="11" r="7" />
                    <path d="m20 20-3.5-3.5" />
                  </svg>
                </div>
                <input
                  type="search"
                  value={query}
                  onChange={(e) => controller.setQuery(e.target.value)}
                  placeholder={
                    filters.contentType === "anime"
                      ? "Search anime..."
                      : filters.contentType === "tv"
                        ? "Search TV shows..."
                        : "Search movies..."
                  }
                  className="search-input"
                  autoComplete="off"
                  spellCheck={false}
                  data-tv-focusable="true"
                  data-tv-primary="true"
                  data-tv-group="search-input"
                  aria-label="Search content"
                />
                <div className="search-input-status">
                  {loading ? (
                    <div
                      className="h-5 w-5 animate-spin rounded-full border-2 border-[rgba(0,229,191,0.25)] border-t-[#00e5bf]"
                      aria-label="Searching"
                    />
                  ) : query ? (
                    <button
                      type="button"
                      onClick={() => controller.setQuery("")}
                      className="flex h-7 w-7 items-center justify-center rounded-full text-white/40 transition hover:bg-white/10 hover:text-white"
                      aria-label="Clear search"
                    >
                      ✕
                    </button>
                  ) : null}
                </div>
              </div>

              {filters.contentType !== "anime" &&
                query.trim() &&
                filters.sortBy !== "relevance" && (
                  <p className="search-results-note">
                    Sorted among loaded title matches. Scroll for more.
                  </p>
                )}
              {error && (
                <div className="search-feedback" role="alert">
                  <p>{error}</p>
                  <button type="button" className="btn-secondary" onClick={controller.retry}>
                    Try again
                  </button>
                </div>
              )}

              {/* Results Grid */}
              {results.length > 0 ? (
                <div className="content-grid">
                  <AnimatePresence mode="popLayout">
                    {results.map((item, index) => {
                      const isAnime = !!(item as any).mal_id;
                      const posterUrl =
                        item.posterPath ||
                        (item.poster_path
                          ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                          : undefined);
                      const itemYear =
                        item.release_date || item.first_air_date || item.releaseDate
                          ? new Date(
                              item.release_date || item.first_air_date || item.releaseDate || "",
                            ).getFullYear()
                          : undefined;
                      const itemMediaType = (item.mediaType === "tv" ? "tv" : "movie") as
                        "movie" | "tv";
                      const animeType = (item as any).anime_type as string | undefined;

                      return (
                        <motion.div
                          key={`${item.id}-${index}`}
                          layout
                          initial={{ opacity: 0, scale: 0.95 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          transition={{ duration: 0.2 }}
                        >
                          <ContentCard
                            tmdbId={Number(item.id) || 0}
                            title={item.title || item.name || "Untitled"}
                            mediaType={itemMediaType}
                            posterUrl={posterUrl}
                            rating={item.vote_average ?? item.rating ?? 0}
                            year={itemYear?.toString()}
                            onClick={() => handleContentClick(item)}
                            badge={
                              animeType
                                ? {
                                    label: animeType,
                                    color:
                                      animeType === "Movie"
                                        ? "#8b7cf0"
                                        : animeType === "TV"
                                          ? "#00e5bf"
                                          : "#f59e0b",
                                  }
                                : isAnime
                                  ? { label: "Anime", color: "#f062a0" }
                                  : undefined
                            }
                          />
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </div>
              ) : (
                !loading &&
                !error && (
                  <div className="search-empty">
                    <div className="search-empty-icon">
                      <svg
                        width="28"
                        height="28"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      >
                        <circle cx="11" cy="11" r="7" />
                        <path d="m20 20-3.5-3.5" />
                      </svg>
                    </div>
                    <p className="font-display text-xl text-white/50">
                      {hasMore ? "No matches in the pages searched yet" : "No results found"}
                    </p>
                    <p className="mt-2 text-sm text-white/30">
                      {hasMore
                        ? "Continue searching for titles that match your filters."
                        : "Try adjusting your search or filters"}
                    </p>
                  </div>
                )
              )}

              {hasMore && !loading && !error && !results.length && (
                <div className="search-feedback">
                  <button type="button" className="btn-secondary" onClick={controller.loadMore}>
                    Search more results
                  </button>
                </div>
              )}

              {/* Loading More Indicator */}
              {(loading || (hasMore && !error && results.length > 0)) && (
                <div
                  ref={observerTarget}
                  className="search-loading"
                  role="status"
                  aria-label={loading ? "Searching titles" : "More results"}
                >
                  {loading && (
                    <div
                      className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin"
                      style={{ borderColor: "rgba(46,230,197,0.25)", borderTopColor: "#2ee6c5" }}
                    />
                  )}
                </div>
              )}
            </main>
          </div>
        </div>
      </div>
    </PageTransition>
  );
}
