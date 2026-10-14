// The demo's data: made up visits to public places in mainland Portugal. Nothing here
// comes from a real map, a real person or a real trip. Ids are fixed so links and tests
// stay stable. Every category appears at least once.
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
    title: "Pastry stop in Belém",
    date_label: "2025-09-14",
    description: "Warm custard tarts by the river, then a walk to the tower.",
    category: "food",
    lat: 38.6979,
    lng: -9.2033,
  },
  {
    title: "Late music in Bairro Alto",
    date_label: "2025-09-13",
    description: "A small room, two guitars and a singer. Standing room only.",
    category: "nightout",
    lat: 38.7139,
    lng: -9.1447,
  },
  {
    title: "Morning market in Porto",
    date_label: "2025-08-30",
    description: "Fruit, bread and coffee before the hill up to the cathedral.",
    category: "everyday",
    lat: 41.1496,
    lng: -8.6062,
  },
  {
    title: "Cliff beach near Lagos",
    date_label: "2025-08-17",
    description: "Wooden stairs down to clear water. Bring shade.",
    category: "beach",
    lat: 37.0869,
    lng: -8.6693,
  },
  {
    title: "Ridge walk in Serra da Estrela",
    date_label: "2025-07-26",
    description: "Granite, wind and a long view east. Four hours there and back.",
    category: "adventure",
    lat: 40.3219,
    lng: -7.6114,
  },
  {
    title: "Weekend in Évora",
    date_label: "2025-06-21",
    description: "White streets, a Roman temple and a very slow lunch.",
    category: "trip",
    lat: 38.5714,
    lng: -7.9135,
  },
  {
    title: "Harbour dinner in Cascais",
    date_label: "2025-05-10",
    description: "Grilled fish by the harbour and a long table that filled up as the evening went on.",
    category: "celebration",
    lat: 38.6979,
    lng: -9.4215,
  },
  {
    title: "First surf lesson in Nazaré",
    date_label: "2025-04-19",
    description: "On the calm beach, not the famous one. Stood up twice.",
    category: "milestone",
    lat: 39.6012,
    lng: -9.07,
  },
  {
    title: "Open air concert in Coimbra",
    date_label: "2025-03-29",
    description: "On the old university steps at dusk. The whole square sang along.",
    category: "concert",
    lat: 40.2075,
    lng: -8.4263,
  },
  {
    title: "Palace gardens in Sintra",
    date_label: "2025-03-08",
    description: "Fog in the trees and a well with a spiral stair.",
    category: "adventure",
    lat: 38.7963,
    lng: -9.3961,
  },
  {
    title: "Boat ride in Aveiro",
    date_label: "2025-02-15",
    description: "Painted boats on the canals and sweet egg pastries after.",
    category: "trip",
    lat: 40.6412,
    lng: -8.6536,
  },
  {
    title: "Harvest lunch in the Douro valley",
    date_label: "2024-10-05",
    description: "Terraced vines above the river and a table under a fig tree.",
    category: "food",
    lat: 41.19,
    lng: -7.546,
  },
];

// The demo's pictures: drawings made in code for this project, kept as files in
// public/demo/location-photos/ and served by the app itself. Not photographs, and not of
// real people. A file is named like an uploaded photo, <location id>-<13 digits>.svg.
// Key: the place's number (1 is the first seed). Value: how many pictures it has.
const PICTURES: Readonly<Record<number, number>> = {
  1: 1,
  4: 1,
  6: 1,
  7: 1,
  8: 1,
  11: 1,
};
const FIRST_STAMP = 1700000000000;

const pictures = (n: number): string[] =>
  Array.from(
    { length: PICTURES[n] ?? 0 },
    (_, k) => `/demo/location-photos/${id(n)}-${FIRST_STAMP + k}.svg`,
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
