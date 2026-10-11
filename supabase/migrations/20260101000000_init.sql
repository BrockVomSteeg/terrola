-- Baseline schema: creates the public.locations table, with row level security
-- on and no policy for anon or authenticated, and the private location-photos
-- storage bucket.
--
-- Safe to run more than once. All access goes through server routes that use the
-- service role key, which bypasses row level security.

-- ---------------------------------------------------------------------------
-- Locations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.locations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title            TEXT NOT NULL,
  date_label       TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  category         TEXT NOT NULL DEFAULT 'everyday',
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  display_order    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Cover photo: a signed read URL, or null when the location has no photos.
  photo_url        TEXT,
  -- Every photo, in display order, as signed read URLs. The first is the cover.
  photos           TEXT[] NOT NULL DEFAULT '{}',

  -- Cover framing in pixels, range -500 to 500. Fallback for photo_offsets.
  photo_offset_x   INTEGER NOT NULL DEFAULT 0,
  photo_offset_y   INTEGER NOT NULL DEFAULT 0,

  -- Per photo framing keyed by storage object name:
  --   { "<object>": { "x": -1..1, "y": -1..1, "scale": 1..3 (optional) } }
  photo_offsets    JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Tiny base64 JPEG placeholders keyed by storage object name:
  --   { "<object>": "data:image/jpeg;base64,..." }
  photo_lqips      JSONB NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT locations_category_check CHECK (category IN (
    'food', 'nightout', 'everyday', 'beach', 'adventure',
    'trip', 'celebration', 'milestone', 'concert'
  ))
);

-- Row level security on with no policy for anon or authenticated: those roles
-- can read and write nothing. The service role bypasses row level security.
ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Photo storage
-- ---------------------------------------------------------------------------

-- Private bucket. Objects are named "<location id>-<timestamp>.<ext>", with a
-- ".thumb" and a ".card" derivative beside each one. The size and type limits
-- match what the photo routes accept.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'location-photos',
  'location-photos',
  false,
  10485760,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;
