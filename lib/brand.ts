// Single source of truth for the product's identity.
// Renaming the project means editing this file, the "name" in package.json, and running
// scripts/rename-project.mjs. Import-free on purpose: safe in edge, server and client bundles.
export const BRAND = {
  name: "Terrola",
  slug: "terrola",
  tagline: "A private map of the places you share.",
  description:
    "A private, shared map for a small group. Pin places, add photos and notes, and see them on a warm, hand-drawn style map.",
} as const;

export type Brand = typeof BRAND;
