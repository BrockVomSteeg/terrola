// Default map view: the world, from Venezuela in the west to Japan in the east, where
// the demo's twelve places are (lib/demo/fixtures.ts). [lng, lat].
export const DEFAULT_CENTER: [number, number] = [32, 28];
export const DEFAULT_ZOOM = 1.4;

// South-west to north-east corner of the default view: every demo place with some room
// around it. Used by the title-click view reset.
export const DEFAULT_BOUNDS: [[number, number], [number, number]] = [
  [-78, 5],
  [142, 50],
];

export const CATEGORIES = {
  food: {
    label: "Food",
    emoji: "🍽️",
    bg: "rgba(193,127,90,0.12)",
    color: "#8B5E3C",
  },
  nightout: {
    label: "Night Out",
    emoji: "🌙",
    bg: "rgba(88,80,120,0.12)",
    color: "#5A5280",
  },
  everyday: {
    label: "Everyday",
    emoji: "☕",
    bg: "rgba(120,90,60,0.12)",
    color: "#6B4F3A",
  },
  beach: {
    label: "Beach",
    emoji: "🏖️",
    bg: "rgba(70,140,160,0.12)",
    color: "#3A7A8A",
  },
  adventure: {
    label: "Adventure",
    emoji: "🏔️",
    bg: "rgba(80,120,80,0.12)",
    color: "#3A6B3A",
  },
  trip: {
    label: "Trip",
    emoji: "✈️",
    bg: "rgba(80,100,160,0.12)",
    color: "#3A5080",
  },
  celebration: {
    label: "Celebration",
    emoji: "🎉",
    bg: "rgba(180,100,100,0.12)",
    color: "#8B3A3A",
  },
  milestone: {
    label: "Milestone",
    emoji: "✨",
    bg: "rgba(180,160,80,0.12)",
    color: "#7A6B20",
  },
  concert: {
    label: "Concert",
    emoji: "🎶",
    bg: "rgba(139,58,107,0.12)",
    color: "#8B3A6B",
  },
} as const;

export type CategoryKey = keyof typeof CATEGORIES;
