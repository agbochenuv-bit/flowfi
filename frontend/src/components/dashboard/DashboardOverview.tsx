import React, { useMemo } from 'react';
import {
  computePortfolioExposure,
  type PortfolioExposureSummary,
  type StreamLike,
  type AssetLike,
} from '../../lib/dashboardExposure';

export interface DashboardOverviewProps {
  streams?: StreamLike[];
  assets?: AssetLike[];
  indexerUpdatedAt?: string | number | Date | null;
  now?: Date;
  staleThresholdMs?: number;
  className?: string;
}

const DEFAULT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

function formatAmount(value: number, symbol?: string): string {
  const formatted = Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 7 })
    : '—';
  return symbol ? `${formatted} ${symbol}` : formatted;
}

function formatTimestamp(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined || value === '') {
    return 'Unknown';
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Unknown';
  }
  return date.toISOString();
}

function isStale(
  updatedAt: string | number | Date | null | undefined,
  now: Date,
  thresholdMs: number,
): boolean {
  if (updatedAt === null || updatedAt === undefined || updatedAt === '') {
    return true;
  }
  const date = updatedAt instanceof Date ? updatedAt : new Date(updatedAt);
  if (Number.isNaN(date.getTime())) {
    return true;
  }
  return now.getTime() - date.getTime() > thresholdMs;
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  streams = [],
  assets = [],
  indexerUpdatedAt = null,
  now,
  staleThresholdMs = DEFAULT_STALE_THRESHOLD_MS,
  className,
}) => {
  const referenceNow = useMemo(() => now ?? new Date(), [now]);

  const exposure: PortfolioExposureSummary = useMemo(
    () => computePortfolioExposure(streams, assets),
    [streams, assets],
  );

  const stale = isStale(indexerUpdatedAt, referenceNow, staleThresholdMs);

  const concentration = exposure.assetConcentration ?? [];
  const hasConcentration = concentration.length > 0;

  return (
    <section
      className={className ? `dashboard-overview ${className}` : 'dashboard-overview'}
      aria-label="Portfolio exposure overview"
    >
      <header className="dashboard-overview__header">
        <h2>Portfolio Exposure</h2>
        <p className="dashboard-overview__source">
          Source: indexer · Updated: {formatTimestamp(indexerUpdatedAt)}
        </p>
      </header>

      {stale && (
        <div
          className="dashboard-overview__notice dashboard-overview__notice--stale"
          role="status"
          aria-live="polite"
        >
          <strong>Stale indexer data.</strong> Figures may be out of date. Verify against
          on-chain state before acting on these numbers.
        </div>
      )}

      <div className="dashboard-overview__grid">
        <div className="dashboard-overview__card">
          <h3>Outgoing Liabilities</h3>
          <p className="dashboard-overview__value">
            {formatAmount(exposure.outgoingLiabilities, exposure.outgoingSymbol)}
          </p>
          <p className="dashboard-overview__meta">
            {exposure.outgoingStreamCount} stream
            {exposure.outgoingStreamCount === 1 ? '' : 's'} · includes paused
          </p>
        </div>

        <div className="dashboard-overview__card">
          <h3>Incoming Expected Payments</h3>
          <p className="dashboard-overview__value">
            {formatAmount(exposure.incomingExpected, exposure.incomingSymbol)}
          </p>
          <p className="dashboard-overview__meta">
            {exposure.incomingStreamCount} stream
            {exposure.incomingStreamCount === 1 ? '' : 's'} · excludes paused
          </p>
        </div>

        <div className="dashboard-overview__card">
          <h3>Net Position</h3>
          <p className="dashboard-overview__value">
            {formatAmount(exposure.netPosition, exposure.netSymbol)}
          </p>
          <p className="dashboard-overview__meta">Incoming minus outgoing</p>
        </div>
      </div>

      <div className="dashboard-overview__concentration">
        <h3>Asset Concentration</h3>
        {hasConcentration ? (
          <ul className="dashboard-overview__concentration-list">
            {concentration.map((entry) => (
              <li key={entry.symbol} className="dashboard-overview__concentration-item">
                <span className="dashboard-overview__concentration-symbol">{entry.symbol}</span>
                <span className="dashboard-overview__concentration-value">
                  {formatAmount(entry.amount, entry.symbol)}
                </span>
                <span className="dashboard-overview__concentration-share">
                  {(entry.share * 100).toFixed(2)}%
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dashboard-overview__empty">No asset exposure recorded.</p>
        )}
      </div>

      <footer className="dashboard-overview__limitations">
        <h4>Data limitations</h4>
        <ul>
          <li>
            Aggregates are derived from indexer-reported streams and may lag on-chain state.
          </li>
          <li>
            Paused streams are excluded from incoming expected payments but retained in outgoing
            liabilities.
          </li>
          <li>
            Mixed-asset totals are reported per asset; cross-asset sums are not converted and
            should not be treated as a single fiat value.
          </li>
          <li>
            Concentration shares are computed over the assets present in this snapshot only.
          </li>
        </ul>
      </footer>
    </section>
  );
};

export default DashboardOverview;