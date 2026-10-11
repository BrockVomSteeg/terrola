export interface Location {
  id: string;
  title: string;
  date_label: string;
  description: string;
  category: CategoryKey;
  lat: number;
  lng: number;
  display_order: number;
  created_at: string;
  photo_url?: string;
  // Signed READ URL for the COVER's small thumbnail (`<coverObject>.thumb`).
  // Attached by the list route (and re-signed per read). Empty/absent when the
  // cover has no thumbnail yet (un-backfilled); consumers fall back to
  // `photo_url`. Served on the map card + timeline so they don't download the
  // full ~2400px original. NOT a DB column; derived per response.
  photo_thumb_url?: string;
  // Signed READ URL for the COVER's card-tier image (`<coverObject>.card`), a
  // ~1152px sharp derivative. Attached by the list route (and re-signed per
  // read). Empty/absent when the cover has no card image yet (un-backfilled);
  // consumers fall back to `photo_url`. Served as the map card's sharp image so
  // it renders crisp at DPR 3 without the full ~2400px original. NOT a DB
  // column; derived per response.
  photo_card_url?: string;
  photos?: string[];
  photo_offset_x?: number;
  photo_offset_y?: number;
  // Per-photo normalized framing, keyed by stable storage path. Backs the
  // edit-mode reframe overlay (supabase/migrations/20260101000000_init.sql).
  // `x`/`y` are pan fractions in [-1, 1] per axis (0 = centered),
  // resolution-independent; optional `scale` is the per-photo zoom in [1, 3]
  // (absent means 1 = no zoom, so a `{x,y}` entry is unchanged).
  photo_offsets?: Record<string, { x: number; y: number; scale?: number }>;
  // Per-photo tiny LQIP placeholders (base64 JPEG data URIs), keyed by stable
  // storage object name; mirrors `photo_offsets`. Backs the instant-blur
  // placeholder. The `photo_lqips` column is created by
  // supabase/migrations/20260101000000_init.sql; NEXT_PUBLIC_LQIP_ENABLED=1
  // enables the feature.
  // Absent means the existing shimmer is used; the feature is a no-op.
  photo_lqips?: Record<string, string>;
  // Derived (NOT a column): the cover photo's LQIP, attached by the list route
  // so the placeholder ships inline with the list (zero extra requests).
  cover_lqip?: string;
}

export type CategoryKey =
  | "food"
  | "nightout"
  | "everyday"
  | "beach"
  | "adventure"
  | "trip"
  | "celebration"
  | "milestone"
  | "concert";

export interface Category {
  label: string;
  bg: string;
  color: string;
  emoji: string;
}
