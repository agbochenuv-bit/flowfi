"use client";

import { RouteErrorView } from "@/components/RouteErrorView";

export default function StreamDetailsError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorView
      title="Stream details unavailable"
      description="Stream details or activity could not be rendered. Retry this stream or return to your dashboard."
      reset={reset}
    />
  );
}