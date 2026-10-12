"use client";

import { ErrorState } from "@/components/app/error-state";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center">
      <ErrorState digest={error.digest} onRetry={reset} />
    </main>
  );
}
