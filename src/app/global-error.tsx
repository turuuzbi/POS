"use client";

// The i18n provider lives in the root layout, which is what failed here, so
// this boundary carries both languages inline.
const TITLE = "Алдаа гарлаа · Something went wrong";
const RETRY = "Дахин оролдох · Try again";

/**
 * Last-resort boundary when the root layout itself fails. It renders without
 * the i18n provider, so it shows both languages side by side.
 */
export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="mn">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          display: "grid",
          placeItems: "center",
          minHeight: "100dvh",
          margin: 0,
        }}
      >
        <main role="alert" style={{ textAlign: "center", padding: 24 }}>
          <h1 style={{ fontSize: 20 }}>{TITLE}</h1>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              minHeight: 44,
              padding: "0 20px",
              fontSize: 16,
              cursor: "pointer",
            }}
          >
            {RETRY}
          </button>
        </main>
      </body>
    </html>
  );
}
