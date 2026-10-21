import { Suspense } from "react";
import SearchPageClient from "./SearchPageClient";

export const metadata = {
  title: "Search",
  description: "Search movies, TV shows, and anime on Flyx",
};

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialSearch = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value])
      initialSearch.append(key, entry);
  }
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center">
          <div className="loading" />
        </div>
      }
    >
      <SearchPageClient initialSearch={initialSearch.toString()} />
    </Suspense>
  );
}
