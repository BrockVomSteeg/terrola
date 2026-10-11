import { getSupabaseAdmin, freshenCoverUrls } from "@/lib/supabase-server";
import { attachCoverLqip } from "@/lib/photos";
import { filterLiveLocations } from "@/lib/locations";
import type { Location } from "@/types";
import MapCanvas from "@/components/Map/MapCanvas";

export const revalidate = 30;

async function getInitialLocations(): Promise<Location[]> {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from("locations")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      if (process.env.NODE_ENV !== "production")
        console.error("[app] Initial locations fetch error:", error);
      return [];
    }

    // Production-only: keep test/null-island rows out of the SSR payload too, so
    // the very first paint of the live app never shows a phantom pin (matches the
    // GET /api/locations filter). No-op in dev.
    const live = filterLiveLocations((data as Location[]) ?? []);
    const freshened = await freshenCoverUrls(live);
    return attachCoverLqip(freshened);
  } catch {
    return [];
  }
}

export default async function MapPage() {
  const initialLocations = await getInitialLocations();

  return (
    <div style={{ height: "100dvh", overflow: "hidden", position: "relative" }}>
      <MapCanvas initialLocations={initialLocations} />
    </div>
  );
}
