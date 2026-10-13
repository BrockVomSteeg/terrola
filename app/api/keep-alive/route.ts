import type { NextRequest } from "next/server";
import { keepAlive } from "@/app/api/_lib/cron";
import { getStore } from "@/lib/demo/gate";

// Never answered from a build time copy.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authorization = request.headers.get("authorization");
  return keepAlive(authorization, {
    env: process.env,
    // Runs only after the secret has matched, and the store checks the secret
    // again itself: nothing touches the database for a caller without it.
    ping: async () => {
      const store = await getStore({ kind: "cron", authorization });
      if (!store.ok) throw new Error("ping failed");
      const result = await store.data.ping();
      if (!result.ok) throw new Error("ping failed");
    },
  });
}
