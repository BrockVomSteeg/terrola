// Shown in the map header of the public demo, so nobody takes the pins for real places
// someone visited or wonders why nothing can be added.
export default function DemoBanner() {
  return (
    <span
      data-testid="demo-banner"
      role="note"
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
      Demo: made up data, read only.
    </span>
  );
}
