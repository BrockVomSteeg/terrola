import { cookies } from "next/headers";
import { getStore } from "@/lib/demo/gate";
import { COOKIE_NAME } from "@/lib/session";
import type { Location } from "@/types";
import MapCanvas from "@/components/Map/MapCanvas";

// Rendered on every request, never from a build time copy (SPEC R3): what this page
// shows depends on the mode and on who is asking.
export const dynamic = "force-dynamic";

async function getInitialLocations(): Promise<Location[]> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  // The gate decides: made up pins in a demo, the database behind a valid session in
  // live mode. It never throws; anything short of a list shows an empty map.
  const store = await getStore({ kind: "session", token });
  if (!store.ok) return [];
  const listed = await store.data.listLocations();
  return listed.ok ? listed.data : [];
}

export default async function MapPage() {
  const initialLocations = await getInitialLocations();

  return (
    <div style={{ height: "100dvh", overflow: "hidden", position: "relative" }}>
      <MapCanvas initialLocations={initialLocations} />
    </div>
  );
}
