"use client"; // Error boundaries must be Client Components

/**
 * Root error boundary (Next.js `global-error` file convention). Catches errors
 * thrown by the root layout/template, the one place segment level error
 * boundaries cannot reach, so the app never shows a blank white screen.
 * Replaces the root layout when active, so it must render its own
 * <html>/<body> (metadata exports are unsupported here; fonts fall back to
 * the system stack).
 *
 * Next 16 passes `unstable_retry`; `reset` is accepted as an alternative, so
 * the retry button works with either prop name.
 */
export default function GlobalError({
  error,
  unstable_retry,
  reset,
}: {
  error: Error & { digest?: string };
  unstable_retry?: () => void;
  reset?: () => void;
}) {
  const retry = unstable_retry ?? reset;

  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#fbf3df",
          color: "#3d2818",
          fontFamily: "Georgia, 'Times New Roman', serif",
          textAlign: "center",
          padding: "24px",
        }}
      >
        <div>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✦</div>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: "0 0 8px" }}>
            Something went wrong
          </h1>
          <p style={{ fontSize: 15, opacity: 0.8, margin: "0 0 20px" }}>
            An unexpected error occurred. Your data is unaffected.
          </p>
          {retry ? (
            <button
              onClick={() => retry()}
              style={{
                background: "#3d2818",
                color: "#fbf3df",
                border: "none",
                borderRadius: 8,
                padding: "10px 22px",
                fontSize: 15,
                cursor: "pointer",
              }}
            >
              Retry
            </button>
          ) : null}
          {error.digest ? (
            <p style={{ fontSize: 11, opacity: 0.5, marginTop: 18 }}>
              ref: {error.digest}
            </p>
          ) : null}
        </div>
      </body>
    </html>
  );
}
