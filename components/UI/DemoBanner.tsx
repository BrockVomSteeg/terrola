// Shown in the map header of the public demo, so nobody takes the pins for real places
// someone visited or wonders why nothing can be added. On a very narrow phone the
// header has no room for the whole sentence, so only the first word shows there; the
// full text stays available to screen readers and as a tooltip.
const FULL_TEXT = "Demo: made up data, read only.";

export default function DemoBanner() {
  return (
    <span
      data-testid="demo-banner"
      role="note"
      aria-label={FULL_TEXT}
      title={FULL_TEXT}
      style={{
        fontSize: "11px",
        lineHeight: 1.3,
        color: "#6B4F3A",
        fontFamily: "var(--font-quicksand), sans-serif",
        background: "rgba(193,127,90,0.10)",
        border: "1px solid rgba(193,127,90,0.28)",
        borderRadius: "100px",
        padding: "3px 10px",
        whiteSpace: "nowrap",
      }}
    >
      <span className="demo-banner-long">Demo: made up data, read only.</span>
      <span className="demo-banner-short">Demo</span>
      <style>{`
        .demo-banner-short { display: none; }
        @media (max-width: 399px) {
          .demo-banner-long { display: none; }
          .demo-banner-short { display: inline; }
        }
      `}</style>
    </span>
  );
}
