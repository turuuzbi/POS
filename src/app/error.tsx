"use client";

import { ErrorState } from "@/components/app/error-state";

export default function RouteError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  /** Re-fetches and re-renders the segment (reset() alone would re-throw). */
  retry: () => void;
}) {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center">
      <ErrorState digest={error.digest} onRetry={retry} />
    </main>
  );
}
