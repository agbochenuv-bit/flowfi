"use client";

import { RouteErrorView } from "@/components/RouteErrorView";

export default function CreateStreamError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorView
      title="Stream form unavailable"
      description="The creation form encountered an unexpected error. Your wallet connection and saved draft are unchanged."
      reset={reset}
    />
  );
}