import type { MediaItem } from "@/types/media";
import {
  searchHref,
  sortSearchItems,
  type SearchFilters,
  type SearchPage,
  type SearchParameters,
  type SearchSnapshot,
} from "./state";

export interface SearchState extends SearchParameters, SearchPage {
  loading: boolean;
  error: string | null;
  resultsHref: string | null;
}

export type SearchFetcher = (
  parameters: SearchParameters,
  page: number,
  signal: AbortSignal,
) => Promise<SearchPage>;

/** One owner for replacement and append requests; newer criteria always supersede older work. */
export class SearchController {
  private state: SearchState;
  private listeners = new Set<() => void>();
  private generation = 0;
  private abort: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    parameters: SearchParameters,
    private fetchPage: SearchFetcher,
  ) {
    this.state = {
      ...parameters,
      items: [],
      page: 0,
      nextPage: 1,
      loading: true,
      error: null,
      resultsHref: null,
    };
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private update(change: Partial<SearchState>) {
    this.state = { ...this.state, ...change };
    this.listeners.forEach((listener) => listener());
  }

  cancel() {
    this.generation += 1;
    this.abort?.abort();
    this.abort = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  activate(parameters: SearchParameters, saved: SearchSnapshot | null = null) {
    this.cancel();
    if (saved && saved.href === searchHref(parameters)) {
      this.update({
        ...parameters,
        items: saved.items,
        page: saved.page,
        nextPage: saved.nextPage,
        loading: false,
        error: null,
        resultsHref: saved.href,
      });
      return;
    }
    this.update({
      ...parameters,
      items: [],
      page: 0,
      nextPage: 1,
      loading: true,
      error: null,
      resultsHref: null,
    });
    void this.request(1, false);
  }

  setQuery(query: string) {
    this.change({ query, filters: this.state.filters }, 500);
  }
  setFilters(change: Partial<SearchFilters>) {
    this.change({ query: this.state.query, filters: { ...this.state.filters, ...change } }, 180);
  }

  private change(parameters: SearchParameters, delay: number) {
    if (searchHref(parameters) === searchHref(this.state)) return;
    this.cancel();
    this.update({
      ...parameters,
      loading: true,
      error: null,
      nextPage: 1,
      page: 0,
      resultsHref: null,
    });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.request(1, false);
    }, delay);
  }

  loadMore = () => {
    if (!this.state.loading && !this.state.error && this.state.nextPage !== null)
      void this.request(this.state.nextPage, true);
  };

  retry = () => {
    if (this.state.loading) return;
    const append = this.state.resultsHref === searchHref(this.state);
    void this.request(append ? (this.state.nextPage ?? 1) : 1, append);
  };

  capture(scrollY: number): SearchSnapshot | null {
    if (this.state.resultsHref !== searchHref(this.state) || this.state.page < 1) return null;
    const { query, filters, items, page, nextPage, resultsHref } = this.state;
    return {
      version: 1,
      href: resultsHref,
      query,
      filters,
      items,
      page,
      nextPage,
      scrollY: Math.max(0, scrollY),
    };
  }

  private async request(page: number, append: boolean) {
    const generation = this.generation;
    const parameters: SearchParameters = { query: this.state.query, filters: this.state.filters };
    const href = searchHref(parameters);
    const abort = new AbortController();
    this.abort = abort;
    this.update({ loading: true, error: null });
    try {
      const response = await this.fetchPage(parameters, page, abort.signal);
      if (abort.signal.aborted || generation !== this.generation) return;
      const unique = new Map<string, MediaItem>();
      for (const item of [...(append ? this.state.items : []), ...response.items])
        unique.set(`${item.mediaType}:${item.id}`, item);
      const items = [...unique.values()];
      this.update({
        items: parameters.query.trim() ? sortSearchItems(items, parameters.filters.sortBy) : items,
        page: response.page,
        nextPage: response.nextPage,
        resultsHref: href,
        loading: false,
      });
    } catch (error) {
      if (abort.signal.aborted || generation !== this.generation) return;
      this.update({
        ...(append ? {} : { items: [], page: 0, resultsHref: null }),
        error: error instanceof Error ? error.message : "Search failed. Please try again.",
        loading: false,
      });
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }
}
