"use client";

import { ErrorState } from "@/components/app/error-state";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorState digest={error.digest} onRetry={reset} />;
}
