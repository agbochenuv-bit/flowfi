"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useWallet } from "@/context/wallet-context";
import { ActivityHistory } from "@/components/dashboard/ActivityHistory";
import { BackendStreamEvent } from "@/lib/api-types";
import { Button } from "@/components/ui/Button";
import { Loader2, Download } from "lucide-react";
import { formatAmount } from "@/utils/amount";
import { downloadCSV } from "@/utils/csvExport";
import { getApiBaseUrl } from "@/lib/api/_shared";
import { authenticatedFetch } from "@/lib/auth";
import { logger } from "@/lib/logger";

const PAGE_SIZE = 10;
const API_BASE_URL = getApiBaseUrl();

const TABS = [
  { id: "ALL", label: "All" },
  { id: "CREATED", label: "Created" },
  { id: "WITHDRAWN", label: "Withdrawals" },
  { id: "TOPPED_UP", label: "Top-ups" },
  { id: "CANCELLED", label: "Cancellations" },
  { id: "PAUSED", label: "Paused/Resumed" },
];

export default function ActivityContent() {
  const { session, status, authToken } = useWallet();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<BackendStreamEvent[]>([]);
  const requestedType = searchParams.get("type") ?? "ALL";
  const activeTab = TABS.some((tab) => tab.id === requestedType) ? requestedType : "ALL";
  const sortOrder = searchParams.get("order") === "asc" ? "asc" : "desc";
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);

  const fetchActivity = useCallback(
    async (nextCursor: string | null, tab: string, order: "asc" | "desc", append: boolean = false, signal?: AbortSignal) => {
      if (!session?.publicKey) return;
      setLoading(true);

      try {
        const typeFilter = tab === "PAUSED" ? "PAUSED,RESUMED" : tab;
        const typeQuery = tab === "ALL" ? "" : `&type=${encodeURIComponent(typeFilter)}`;
        const url =
          `${API_BASE_URL}/v1/events?address=${encodeURIComponent(session.publicKey)}` +
          `&limit=${PAGE_SIZE}&order=${order}${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ""}${typeQuery}`;

        const response = await authenticatedFetch(url, {
          signal,
        }, authToken);
        if (!response.ok) {
          throw new Error(`Failed to fetch activity (${response.status})`);
        }
        const data = await response.json();

        const next: BackendStreamEvent[] = Array.isArray(data?.events)
          ? data.events
          : [];

        setEvents((prev) => {
          const combined = append ? [...prev, ...next] : next;
          return [...new Map(combined.map((event) => [event.id, event])).values()];
        });
        setCursor(typeof data?.nextCursor === "string" ? data.nextCursor : null);

        if (typeof data?.hasMore === "boolean") {
          setHasMore(data.hasMore);
        } else {
          setHasMore(next.length === PAGE_SIZE);
        }
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        logger.error("Failed to fetch activity:", error);
        if (!append) setEvents([]);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [session, authToken],
  );

  const updateView = (type: string, order: "asc" | "desc") => {
    const params = new URLSearchParams(searchParams.toString());
    if (type === "ALL") params.delete("type");
    else params.set("type", type);
    params.set("order", order);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    if (status !== "connected") return;
    const controller = new AbortController();
    const initLoad = async () => {
      setCursor(null);
      await fetchActivity(null, activeTab, sortOrder, false, controller.signal);
    };
    void initLoad();
    return () => controller.abort();
  }, [activeTab, sortOrder, status, fetchActivity]);

  const loadMore = () => {
    if (cursor) fetchActivity(cursor, activeTab, sortOrder, true);
  };

  const handleExportCSV = () => {
    const csvData = events.map(event => ({
        'Stream ID': event.streamId,
        'Event Type': event.eventType,
        'Amount': event.amount ? formatAmount(BigInt(event.amount), 7) : '0',
        'Timestamp': new Date(event.timestamp * 1000).toLocaleString(),
        'Transaction Hash': event.transactionHash,
        'Ledger': event.ledgerSequence,
    }));
    downloadCSV(csvData, `flowfi-activity-${Date.now()}.csv`);
  };

  if (status !== "connected") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] text-center">
        <h1 className="text-2xl font-bold mb-2 text-white">Access Denied</h1>
        <p className="text-slate-400">
          Please connect your wallet to view your stream history.
        </p>
      </div>
    );
  }

  return (
    <main className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
      <header className="mb-8 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-white mb-2">Stream Activity</h1>
          <p className="text-slate-400">
            Track all your incoming and outgoing payment stream events.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleExportCSV}
          disabled={events.length === 0}
          className="sm:w-auto w-full"
        >
          <Download className="h-4 w-4 mr-2" />
          Export CSV
        </Button>
      </header>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-4 mb-6 no-scrollbar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              updateView(tab.id, sortOrder);
            }}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-all whitespace-nowrap border ${
              activeTab === tab.id
                ? "bg-accent text-white border-accent"
                : "bg-white/5 text-slate-400 border-white/10 hover:bg-white/10"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <label className="mb-4 flex items-center justify-end gap-2 text-sm text-slate-400">
        Sort
        <select
          value={sortOrder}
          onChange={(event) => updateView(activeTab, event.target.value === "asc" ? "asc" : "desc")}
          className="rounded border border-white/10 bg-slate-900 px-3 py-2 text-white"
        >
          <option value="desc">Newest first</option>
          <option value="asc">Oldest first</option>
        </select>
      </label>

      <ActivityHistory events={events} isLoading={loading && events.length === 0} />

      {hasMore && cursor && (
        <div className="mt-12 flex justify-center">
          <Button
            variant="secondary"
            onClick={loadMore}
            disabled={loading}
            className="w-full sm:w-auto min-w-[200px]"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Load More Activity
          </Button>
        </div>
      )}
    </main>
  );
}
