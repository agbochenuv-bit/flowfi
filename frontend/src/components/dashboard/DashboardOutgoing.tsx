import { EmptyState } from "./dashboard-view";
import { BoltIcon } from "./dashboard-view";
import { Button } from "@/components/ui/Button";
import type { Stream } from "@/lib/dashboard";
import {
  summarizeOutgoingExposure,
  type ExposureSource,
} from "@/lib/portfolioExposure";

interface DashboardOutgoingProps {
  outgoingStreams: Stream[];
  onTopUp: (stream: Stream) => void;
  onCancel: (stream: Stream) => void;
  onShowDetails: (stream: Stream) => void;
  setShowWizard: () => void;
  /** Stream highlighted by keyboard navigation (j/k). */
  selectedStreamId?: string | null;
  /** Timestamp (ms) of the data backing the outgoing list, if known. */
  sourceTimestamp?: number | null;
  /** Where the outgoing data came from, used to flag stale indexer data. */
  source?: ExposureSource;
  /** Current time (ms) used for staleness checks; defaults to Date.now(). */
  now?: number;
}

export function DashboardOutgoing({
  outgoingStreams,
  onTopUp,
  onCancel,
  onShowDetails,
  setShowWizard,
  selectedStreamId = null,
  sourceTimestamp = null,
  source = "indexer",
  now,
}: DashboardOutgoingProps) {
  const activeOutgoing = outgoingStreams.filter((s) => s.status === "Active");
  const exposure = summarizeOutgoingExposure(outgoingStreams, {
    sourceTimestamp,
    source,
    now,
  });

  if (activeOutgoing.length === 0) {
    return (
      <EmptyState
        icon={<BoltIcon />}
        title="No active outgoing streams"
        description="You don't have any active outgoing payment streams. Create one to start streaming tokens to a recipient."
        action={
          <Button onClick={setShowWizard} glow>
            Create a Stream
          </Button>
        }
      />
    );
  }

  return (
    <div className="mt-8">
      <section className="dashboard-panel" aria-label="Outgoing liabilities">
        <div className="dashboard-panel__header">
          <h3>Outgoing Liabilities</h3>
          <span>
            {exposure.sourceTimestamp
              ? `Updated ${new Date(exposure.sourceTimestamp).toLocaleString()}`
              : "Timestamp unavailable"}
          </span>
        </div>
        <div className="p-4 space-y-3">
          {exposure.isStale && (
            <p
              role="status"
              className="text-sm text-amber-400"
              data-testid="outgoing-stale-warning"
            >
              Data may be stale{exposure.source === "indexer" ? " (indexer)" : ""}.
              Remaining obligations may not reflect recent activity.
            </p>
          )}
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-slate-400">Remaining obligation</dt>
              <dd className="font-semibold text-accent" data-testid="outgoing-remaining">
                {exposure.remainingByAsset.length === 0
                  ? "—"
                  : exposure.remainingByAsset
                      .map((b) => `${b.amount} ${b.asset}`)
                      .join(", ")}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Active streams</dt>
              <dd className="font-semibold" data-testid="outgoing-active-count">
                {exposure.activeStreamCount}
              </dd>
            </div>
            <div>
              <dt className="text-slate-400">Paused streams</dt>
              <dd className="font-semibold" data-testid="outgoing-paused-count">
                {exposure.pausedStreamCount}
              </dd>
            </div>
          </dl>
          <div>
            <h4 className="text-sm text-slate-400 mb-1">Asset concentration</h4>
            {exposure.concentration.length === 0 ? (
              <p className="text-sm text-slate-500">No active obligations.</p>
            ) : (
              <ul className="space-y-1" data-testid="outgoing-concentration">
                {exposure.concentration.map((c) => (
                  <li key={c.asset} className="flex items-center gap-2 text-sm">
                    <span className="w-16 font-mono">{c.asset}</span>
                    <span className="flex-1 h-2 rounded bg-white/10 overflow-hidden">
                      <span
                        className="block h-full bg-accent"
                        style={{ width: `${Math.round(c.share * 100)}%` }}
                      />
                    </span>
                    <span className="w-12 text-right text-slate-400">
                      {(c.share * 100).toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <p className="text-xs text-slate-500">
            Estimates only. Obligations are derived from stream balances and may
            exclude unindexed activity or assets without a price feed.
          </p>
        </div>
      </section>
      <section className="dashboard-panel">
        <div className="dashboard-panel__header">
          <h3>My Active Streams</h3>
          <span>{activeOutgoing.length} total</span>
        </div>
        <div className="overflow-x-auto">
          <table className="dashboard-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Recipient</th>
                <th>Deposited</th>
                <th>Withdrawn</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeOutgoing.map((stream) => (
                <tr
                  key={stream.id}
                  data-stream-id={stream.id}
                  aria-selected={selectedStreamId === stream.id}
                  className={`cursor-pointer hover:bg-white/5 ${
                    selectedStreamId === stream.id
                      ? "bg-accent/10 ring-1 ring-inset ring-accent/40"
                      : ""
                  }`}
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest("button")) return;
                    onShowDetails(stream);
                  }}
                >
                  <td>{stream.date}</td>
                  <td>
                    <code className="text-xs">{stream.recipient}</code>
                  </td>
                  <td className="font-semibold text-accent">
                    {stream.deposited} {stream.token}
                  </td>
                  <td className="text-slate-400">
                    {stream.withdrawn} {stream.token}
                  </td>
                  <td className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        className="secondary-button py-1 px-3 text-sm h-auto inline-flex items-center"
                      >
                        Details
                      </Button>
                      <Button
                        type="button"
                        className="secondary-button py-1 px-3 text-sm h-auto"
                        onClick={() => onTopUp(stream)}
                      >
                        Add Funds
                      </Button>
                      <Button
                        type="button"
                        className="py-1 px-3 text-sm rounded-full border border-red-500/40 text-red-400 hover:bg-red-500/10 transition-colors font-semibold"
                        onClick={() => onCancel(stream)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}