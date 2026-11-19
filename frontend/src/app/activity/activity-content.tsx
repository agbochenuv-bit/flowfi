'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ActivityFilters,
  DEFAULT_ACTIVITY_FILTERS,
  parseActivityFilters,
  serializeActivityFilters,
  hasActiveFilters,
  ActivitySortField,
  ActivitySortDirection,
} from './activityFilters';

export interface ActivityEvent {
  id: string;
  cursor: string;
  asset: string;
  participant: string;
  action: string;
  amount: string;
  timestamp: string;
  network: string;
  txHash: string;
}

export interface ActivityPage {
  events: ActivityEvent[];
  nextCursor: string | null;
  prevCursor: string | null;
}

export interface ActivityContentProps {
  network: string;
  fetchActivity: (params: {
    network: string;
    filters: ActivityFilters;
    cursor: string | null;
    limit: number;
  }) => Promise<ActivityPage>;
  pageSize?: number;
}

const LIFECYCLE_ACTIONS = [
  'created',
  'started',
  'paused',
  'resumed',
  'withdrawn',
  'cancelled',
  'completed',
] as const;

const SORT_FIELDS: ActivitySortField[] = ['timestamp', 'amount', 'asset', 'participant'];
const SORT_DIRECTIONS: ActivitySortDirection[] = ['asc', 'desc'];

const DEFAULT_PAGE_SIZE = 20;

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

export default function ActivityContent({
  network,
  fetchActivity,
  pageSize = DEFAULT_PAGE_SIZE,
}: ActivityContentProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const filters = useMemo(
    () => parseActivityFilters(new URLSearchParams(searchParams.toString())),
    [searchParams],
  );

  const cursor = searchParams.get('cursor');

  const [page, setPage] = useState<ActivityPage | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState<string>(filters.search ?? '');

  const requestIdRef = useRef(0);

  // Keep the search draft in sync when the URL changes (e.g. back/forward).
  useEffect(() => {
    setSearchDraft(filters.search ?? '');
  }, [filters.search]);

  const updateFilters = useCallback(
    (next: Partial<ActivityFilters>, options?: { resetCursor?: boolean }) => {
      const merged: ActivityFilters = { ...filters, ...next };
      const resetCursor = options?.resetCursor ?? true;
      const params = serializeActivityFilters(merged, {
        network,
        cursor: resetCursor ? null : cursor,
      });
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [filters, network, cursor, pathname, router],
  );

  const handleSearchSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const trimmed = searchDraft.trim();
      updateFilters({ search: trimmed.length > 0 ? trimmed : undefined });
    },
    [searchDraft, updateFilters],
  );

  const handleClearFilters = useCallback(() => {
    setSearchDraft('');
    const params = serializeActivityFilters(DEFAULT_ACTIVITY_FILTERS, {
      network,
      cursor: null,
    });
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [network, pathname, router]);

  const handleNextPage = useCallback(() => {
    if (!page?.nextCursor) {
      return;
    }
    const params = serializeActivityFilters(filters, {
      network,
      cursor: page.nextCursor,
    });
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [page, filters, network, pathname, router]);

  const handlePrevPage = useCallback(() => {
    if (!page?.prevCursor) {
      return;
    }
    const params = serializeActivityFilters(filters, {
      network,
      cursor: page.prevCursor,
    });
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [page, filters, network, pathname, router]);

  // Fetch data whenever network, filters, or cursor change.
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    let cancelled = false;

    setLoading(true);
    setError(null);

    fetchActivity({ network, filters, cursor, limit: pageSize })
      .then((result) => {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }
        setPage(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled || requestId !== requestIdRef.current) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load activity');
        setPage(null);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [network, filters, cursor, pageSize, fetchActivity]);

  const filtersActive = hasActiveFilters(filters);
  const events = page?.events ?? [];

  return (
    <div className="activity-content">
      <header className="activity-header">
        <h1>Activity Explorer</h1>
        <p className="activity-network" data-testid="activity-network">
          Network: <strong>{network}</strong>
        </p>
      </header>

      <form className="activity-filters" onSubmit={handleSearchSubmit} role="search">
        <div className="activity-filter-field">
          <label htmlFor="activity-asset">Asset</label>
          <input
            id="activity-asset"
            type="text"
            value={filters.asset ?? ''}
            onChange={(e) =>
              updateFilters({ asset: e.target.value.trim() || undefined })
            }
            placeholder="e.g. USDC"
          />
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-participant">Participant</label>
          <input
            id="activity-participant"
            type="text"
            value={filters.participant ?? ''}
            onChange={(e) =>
              updateFilters({ participant: e.target.value.trim() || undefined })
            }
            placeholder="Address or name"
          />
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-action">Lifecycle action</label>
          <select
            id="activity-action"
            value={filters.action ?? ''}
            onChange={(e) =>
              updateFilters({ action: e.target.value || undefined })
            }
          >
            <option value="">All actions</option>
            {LIFECYCLE_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </select>
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-from">From</label>
          <input
            id="activity-from"
            type="date"
            value={filters.from ?? ''}
            onChange={(e) =>
              updateFilters({ from: e.target.value || undefined })
            }
          />
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-to">To</label>
          <input
            id="activity-to"
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => updateFilters({ to: e.target.value || undefined })}
          />
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-search">Search</label>
          <input
            id="activity-search"
            type="search"
            value={searchDraft}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Search events"
          />
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-sort-field">Sort by</label>
          <select
            id="activity-sort-field"
            value={filters.sortField}
            onChange={(e) =>
              updateFilters({ sortField: e.target.value as ActivitySortField })
            }
          >
            {SORT_FIELDS.map((field) => (
              <option key={field} value={field}>
                {field}
              </option>
            ))}
          </select>
        </div>

        <div className="activity-filter-field">
          <label htmlFor="activity-sort-direction">Direction</label>
          <select
            id="activity-sort-direction"
            value={filters.sortDirection}
            onChange={(e) =>
              updateFilters({
                sortDirection: e.target.value as ActivitySortDirection,
              })
            }
          >
            {SORT_DIRECTIONS.map((direction) => (
              <option key={direction} value={direction}>
                {direction}
              </option>
            ))}
          </select>
        </div>

        <div className="activity-filter-actions">
          <button type="submit">Apply search</button>
          <button
            type="button"
            onClick={handleClearFilters}
            disabled={!filtersActive && searchDraft.length === 0}
          >
            Clear filters
          </button>
        </div>
      </form>

      {loading ? (
        <div className="activity-loading" role="status" aria-live="polite">
          Loading activity…
        </div>
      ) : error ? (
        <div className="activity-error" role="alert">
          {error}
        </div>
      ) : events.length === 0 ? (
        <div className="activity-empty" data-testid="activity-empty">
          {filtersActive
            ? 'No activity matches the selected filters.'
            : 'No activity has been recorded for this network yet.'}
        </div>
      ) : (
        <table className="activity-table">
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Asset</th>
              <th scope="col">Participant</th>
              <th scope="col">Action</th>
              <th scope="col">Amount</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id} data-testid="activity-row">
                <td>{formatTimestamp(event.timestamp)}</td>
                <td>{event.asset}</td>
                <td>{event.participant}</td>
                <td>{event.action}</td>
                <td>{event.amount}</td>
                <td>
                  <code>{event.txHash}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <nav className="activity-pagination" aria-label="Activity pagination">
        <button
          type="button"
          onClick={handlePrevPage}
          disabled={loading || !page?.prevCursor}
        >
          Previous
        </button>
        <button
          type="button"
          onClick={handleNextPage}
          disabled={loading || !page?.nextCursor}
        >
          Next
        </button>
      </nav>
    </div>
  );
}