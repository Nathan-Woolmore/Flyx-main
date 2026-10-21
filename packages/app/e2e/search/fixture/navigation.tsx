import { useEffect, useMemo, useState } from "react";
export function useRouter() {
  return {
    push(href: string) {
      window.history.pushState({ fixture: true }, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    back() {
      window.history.back();
    },
  };
}

export function useSearchParams() {
  const [search, setSearch] = useState(window.location.search);
  useEffect(() => {
    const update = () => setSearch(window.location.search);
    window.addEventListener("popstate", update);
    return () => window.removeEventListener("popstate", update);
  }, []);
  return useMemo(() => new URLSearchParams(search), [search]);
}
