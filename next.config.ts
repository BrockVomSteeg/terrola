import type { NextConfig } from "next";

// Content-Security-Policy, report-only: logs would-be violations to the browser
// console and blocks nothing. Change the header key to
// "Content-Security-Policy" to enforce it after a clean observation window.
// Derived from this app's actual external surfaces:
//  - Mapbox GL JS v3: web workers from blob: (worker-src/child-src), tiles +
//    styles + glyphs + telemetry via fetch (connect-src api/events.mapbox.com)
//  - Supabase Storage: signed-URL images (img-src) + direct browser upload
//    PUTs and API calls (connect-src *.supabase.co)
//  - next/font self-hosts fonts (font-src 'self'; data: for inline fallbacks)
//  - script-src 'unsafe-inline': Next.js App Router inline bootstrap scripts
//    without nonce infrastructure; 'unsafe-eval' DEV-ONLY (React error-stack
//    tooling). style-src 'unsafe-inline': React style attributes + Mapbox GL
//    injected styles. blob:/data: img-src: AdminPanel canvas compression
//    previews.
const isDev = process.env.NODE_ENV === "development";
const cspReportOnly = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data: https://*.supabase.co https://api.mapbox.com",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co https://api.mapbox.com https://events.mapbox.com https://*.tiles.mapbox.com",
  "worker-src 'self' blob:",
  "child-src blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  experimental: {
    serverActions: { bodySizeLimit: "15mb" },
  },
  headers: async () => [
    {
      source: "/(.*)",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
        { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
      ],
    },
  ],
};

export default nextConfig;
