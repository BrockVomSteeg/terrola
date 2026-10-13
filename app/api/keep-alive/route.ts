import type { NextRequest } from "next/server";
import { keepAlive } from "@/app/api/_lib/cron";

// Never answered from a build time copy.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return keepAlive(request.headers.get("authorization"), {
    env: process.env,
    // Loaded only after the secret has matched: nothing touches the database
    // for a caller without it.
    ping: async () => {
      const { getSupabaseAdmin } = await import("@/lib/supabase-server");
      const { error } = await getSupabaseAdmin()
        .from("locations")
        .select("id", { count: "exact", head: true });
      if (error) throw new Error("ping failed");
    },
  });
}
