"use client";

import { RouteErrorView } from "@/components/RouteErrorView";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <RouteErrorView
      title="Dashboard unavailable"
      description="The wallet dashboard hit an unexpected error. Retry to reload the view, or return home and reconnect your wallet."
      reset={reset}
      returnHref="/"
      returnLabel="Return home"
    />
  );
}