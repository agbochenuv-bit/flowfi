"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface RouteErrorViewProps {
  title: string;
  description: string;
  reset: () => void;
  returnHref?: string;
  returnLabel?: string;
}

export function RouteErrorView({
  title,
  description,
  reset,
  returnHref = "/dashboard",
  returnLabel = "Return to dashboard",
}: RouteErrorViewProps) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-2xl flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-full border border-red-400/30 bg-red-400/10 text-red-300">
        <AlertTriangle aria-hidden="true" size={22} />
      </div>
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      <p className="mt-2 max-w-lg text-sm text-slate-400">{description}</p>
      <div className="mt-6 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <RotateCcw aria-hidden="true" size={16} />
          Try again
        </button>
        <Link
          href={returnHref}
          className="inline-flex items-center rounded-md border border-glass-border px-4 py-2 text-sm font-semibold text-foreground hover:bg-white/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {returnLabel}
        </Link>
      </div>
    </main>
  );
}