"use client";

import { useEffect, useRef, useState } from "react";
import type { Location } from "@/types";

interface StatsBarProps {
  locations: Location[];
}

function haversine(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function computeStats(locations: Location[]) {
  const count = locations.length;

  const sorted = [...locations].sort((a, b) =>
    a.date_label.localeCompare(b.date_label),
  );
  let miles = 0;
  for (let i = 1; i < sorted.length; i++) {
    miles += haversine(
      sorted[i - 1].lat,
      sorted[i - 1].lng,
      sorted[i].lat,
      sorted[i].lng,
    );
  }
  miles = Math.round(miles);

  let sinceLabel = "";
  if (locations.length > 0) {
    const dates = locations
      .map((l) => new Date(l.date_label))
      .filter((d) => !isNaN(d.getTime()));
    if (dates.length > 0) {
      const earliest = new Date(Math.min(...dates.map((d) => d.getTime())));
      sinceLabel = earliest.toLocaleDateString("en-US", {
        month: "long",
        year: "numeric",
      });
    }
  }

  return { count, miles, sinceLabel };
}

export default function StatsBar({ locations }: StatsBarProps) {
  const { count, miles, sinceLabel } = computeStats(locations);

  const [displayCount, setDisplayCount] = useState(0);
  const [displayMiles, setDisplayMiles] = useState(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = performance.now();
    const duration = 1200;

    function animate(now: number) {
      const t = Math.min((now - start) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplayCount(Math.round(eased * count));
      setDisplayMiles(Math.round(eased * miles));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    }

    rafRef.current = requestAnimationFrame(animate);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [count, miles]);

  return (
    <div
      className="stats-bar"
      style={{
        background: "rgba(250,246,240,0.95)",
        borderTop: "1px solid rgba(193,127,90,0.12)",
        padding: "16px 20px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-around",
        flexShrink: 0,
      }}
    >
      <Stat value={String(displayCount)} label="places" />
      <Divider />
      <Stat value={String(displayMiles)} label="miles" />
      <Divider />
      <Stat value={sinceLabel} label="since" />
    </div>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: "3px",
      }}
    >
      <span
        style={{
          fontFamily: "var(--font-cormorant), serif",
          fontSize: "26px",
          fontWeight: 400,
          color: "#4A3728",
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: "var(--font-quicksand), sans-serif",
          fontSize: "10px",
          textTransform: "uppercase",
          letterSpacing: "1.5px",
          color: "#9B8578",
          lineHeight: 1,
        }}
      >
        {label}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        width: "1px",
        height: "32px",
        background: "rgba(193,127,90,0.2)",
        flexShrink: 0,
      }}
    />
  );
}
