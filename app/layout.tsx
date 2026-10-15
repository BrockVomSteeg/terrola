import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { BRAND } from "@/lib/brand";

// Fonts live in the repository (app/fonts), so a build never downloads them.
// Sources and licences: docs/ASSETS.md and THIRD_PARTY_NOTICES.md.
const cormorant = localFont({
  variable: "--font-cormorant",
  src: [
    { path: "./fonts/cormorant-garamond/CormorantGaramond-latin.woff2", weight: "300 600", style: "normal" },
    { path: "./fonts/cormorant-garamond/CormorantGaramond-Italic-latin.woff2", weight: "300 600", style: "italic" },
  ],
  display: "swap",
});

const quicksand = localFont({
  variable: "--font-quicksand",
  src: "./fonts/quicksand/Quicksand-latin.woff2",
  weight: "300 600",
  display: "swap",
});

const fraunces = localFont({
  variable: "--font-fraunces",
  src: "./fonts/fraunces/Fraunces-Italic-800-latin.woff2",
  weight: "800",
  style: "italic",
  display: "swap",
});

export const metadata: Metadata = {
  title: BRAND.name,
  description: BRAND.description,
  robots: "noindex, nofollow",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: BRAND.name,
  },
  icons: {
    apple: "/icon-192.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#C17F5A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${cormorant.variable} ${quicksand.variable} ${fraunces.variable} h-full`}
    >
      <body className="h-full" style={{ overflow: "hidden" }}>
        {children}
      </body>
    </html>
  );
}
