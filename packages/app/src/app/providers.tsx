"use client";

import RemoteHost from "@/lib/remote/RemoteHost";
import type { ReactNode } from "react";
import { AnalyticsProvider } from "@/components/analytics/AnalyticsProvider";
import { PresenceProvider } from "@/components/analytics/PresenceProvider";
import { CommandPaletteProvider } from "@/components/search/CommandPalette";

export function AppProvider({ children }: { children: ReactNode }) {
  return (
    <AnalyticsProvider>
      <PresenceProvider>
        <CommandPaletteProvider><RemoteHost />{children}</CommandPaletteProvider>
      </PresenceProvider>
    </AnalyticsProvider>
  );
}
