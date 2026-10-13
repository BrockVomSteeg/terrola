import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getStore } from "@/lib/demo/gate";
import { getMode } from "@/lib/mode";
import { COOKIE_NAME } from "@/lib/session";
import type { Location } from "@/types";
import MapCanvas from "@/components/Map/MapCanvas";

// Rendered on every request, never from a build time copy (SPEC R3): what this page
// shows depends on the mode and on who is asking.
export const dynamic = "force-dynamic";

async function getInitialLocations(): Promise<Location[]> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  // The gate decides: made up pins in a demo, the database behind a valid session in
  // live mode. It never throws. A failure other than a missing session shows an
  // empty map.
  const store = await getStore({ kind: "session", token });
  // Only reachable if the proxy was skipped: no session, so back to the login page
  // instead of an empty map that keeps asking for data it will not get.
  if (!store.ok && store.error.code === "unauthorized") redirect("/");
  if (!store.ok) return [];
  const listed = await store.data.listLocations();
  return listed.ok ? listed.data : [];
}

/** The public demo shows no control that could add, change or remove anything. */
function isReadOnly(): boolean {
  try {
    return getMode() === "demo-readonly";
  } catch {
    // A refused configuration never reaches this page: the proxy answers 503 first.
    return true;
  }
}

export default async function MapPage() {
  const initialLocations = await getInitialLocations();

  return (
    <div style={{ height: "100dvh", overflow: "hidden", position: "relative" }}>
      <MapCanvas initialLocations={initialLocations} readOnly={isReadOnly()} />
    </div>
  );
}
