"use client";

import { RouteErrorView } from "@/components/RouteErrorView";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorView
      title="This page could not be loaded"
      description="Your wallet and cached data are unchanged. Retry the view or return to the dashboard."
      reset={reset}
      returnHref="/"
      returnLabel="Go to home"
    />
  );
}