"use client";

import { ErrorState } from "@/components/app/error-state";

export default function AdminError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  /** Re-fetches and re-renders the segment (reset() alone would re-throw). */
  retry: () => void;
}) {
  return <ErrorState digest={error.digest} onRetry={retry} />;
}
