// The demo's data: made up visits to twelve public places around the world, each one
// where a free photograph was taken. The titles, dates and words are invented; no real
// person or real trip is behind them. Ids are fixed so links and tests stay stable.
// Every category appears at least once.
//
// Import-free apart from types: safe anywhere.
import type { Location } from "@/types";

const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

type Seed = Pick<
  Location,
  "title" | "date_label" | "description" | "category" | "lat" | "lng"
>;

const SEEDS: readonly Seed[] = [
  {
    title: "Pepper stall at the market",
    date_label: "2025-09-20",
    description: "Red, green and yellow peppers piled high. Bought far too many for one pan.",
    category: "food",
    lat: 10.6396,
    lng: -71.6151,
  },
  {
    title: "Harbour lights in Hong Kong",
    date_label: "2025-09-06",
    description: "The towers lit up across the water. Stayed out until the last ferry.",
    category: "nightout",
    lat: 22.3033,
    lng: 114.1603,
  },
  {
    title: "Cherry blossom walk in Kyoto",
    date_label: "2025-04-05",
    description: "Pink trees along the river and the mountain behind them. An easy morning.",
    category: "everyday",
    lat: 35.0485,
    lng: 135.7852,
  },
  {
    title: "Swim at a quiet lake in Andalusia",
    date_label: "2025-08-16",
    description: "Warm water, pale banks and hardly anyone else. Bring a hat.",
    category: "beach",
    lat: 36.9964,
    lng: -3.8945,
  },
  {
    title: "Canyon hike in Charyn",
    date_label: "2025-05-03",
    description: "Red rock walls on both sides and a river at the bottom. Five hours there and back.",
    category: "adventure",
    lat: 43.3564,
    lng: 79.092,
  },
  {
    title: "Dawn at the Alhambra",
    date_label: "2025-03-08",
    description: "Up before the sun to see the palace turn gold. Worth the early alarm.",
    category: "trip",
    lat: 37.181,
    lng: -3.5928,
  },
  {
    title: "Sunset toast at Juan Griego",
    date_label: "2025-07-26",
    description: "Glasses up as the sun went down over the bay. The whole beach clapped.",
    category: "celebration",
    lat: 11.0805,
    lng: -63.9737,
  },
  {
    title: "First summit at the Aiguille Rouge",
    date_label: "2025-07-12",
    description: "Snow peaks in every direction and very cold hands. A first time at the top.",
    category: "milestone",
    lat: 45.5519,
    lng: 6.8483,
  },
  {
    title: "Night concert by the Expo Bridge",
    date_label: "2025-06-21",
    description: "A stage by the river and the bridge lit up behind it. We danced on the grass.",
    category: "concert",
    lat: 36.3726,
    lng: 127.388,
  },
  {
    title: "Evening at the Temple of Zeus",
    date_label: "2025-06-07",
    description: "Tall old columns in the last light, then a slow walk down to dinner.",
    category: "trip",
    lat: 37.9691,
    lng: 23.7335,
  },
  {
    title: "Camp near the Flaming Cliffs",
    date_label: "2025-05-24",
    description: "Orange rock, wide sky and a very quiet night in the desert.",
    category: "adventure",
    lat: 44.14,
    lng: 103.7173,
  },
  {
    title: "Dinner below the Segovia aqueduct",
    date_label: "2025-01-18",
    description: "A long dinner under the old stone arches, lit up as the sky went dark.",
    category: "food",
    lat: 40.9479,
    lng: -4.1167,
  },
];

// The demo's pictures: real photographs, one for each place, taken where the place is.
// Each is free to use (CC0 1.0, public domain), resized to 1400 pixels and stripped of
// its metadata; docs/ASSETS.md names the source page and author of every file. They are
// kept in public/demo/location-photos/ and served by the app itself. A file is named
// like an uploaded photo, <location id>-<13 digits>.jpg.
// Key: the place's number (1 is the first seed). Value: how many pictures it has.
const PICTURES: Readonly<Record<number, number>> = {
  1: 1,
  2: 1,
  3: 1,
  4: 1,
  5: 1,
  6: 1,
  7: 1,
  8: 1,
  9: 1,
  10: 1,
  11: 1,
  12: 1,
};
const FIRST_STAMP = 1700000000000;

const pictures = (n: number): string[] =>
  Array.from(
    { length: PICTURES[n] ?? 0 },
    (_, k) => `/demo/location-photos/${id(n)}-${FIRST_STAMP + k}.jpg`,
  );

// Newest first, one day apart, so the order is the same on every run.
const NEWEST = Date.UTC(2025, 9, 1, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

export const DEMO_LOCATIONS: readonly Location[] = SEEDS.map((seed, index) => {
  const photos = pictures(index + 1);
  return {
    ...seed,
    id: id(index + 1),
    display_order: 0,
    created_at: new Date(NEWEST - index * DAY).toISOString(),
    photos,
    // The cover is the first picture, as it is after an upload.
    ...(photos.length > 0 ? { photo_url: photos[0] } : {}),
  };
});
