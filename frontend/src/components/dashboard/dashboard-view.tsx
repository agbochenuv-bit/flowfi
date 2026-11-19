'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchRecurringSchedules,
  fetchScheduleStreams,
  pauseRecurringSchedule,
  cancelRecurringSchedule,
  type RecurringSchedule,
  type ScheduleStream,
  type ScheduleStatus,
  type StreamStatus,
} from '@/lib/api/streams';
import { useWallet } from '@/hooks/use-wallet';
import { useNetwork } from '@/hooks/use-network';

type LoadState = 'idle' | 'loading' | 'error' | 'ready';

interface ScheduleWithStreams {
  schedule: RecurringSchedule;
  streams: ScheduleStream[];
}

const STATUS_LABELS: Record<ScheduleStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  cancelled: 'Cancelled',
  completed: 'Completed',
  missed: 'Missed run',
  insufficient_funds: 'Insufficient funds',
};

const STREAM_STATUS_LABELS: Record<StreamStatus, string> = {
  pending: 'Pending',
  funded: 'Funded',
  streaming: 'Streaming',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString();
}

function formatAmount(amount: string, asset: string): string {
  return `${amount} ${asset}`;
}

function statusClass(status: ScheduleStatus): string {
  switch (status) {
    case 'active':
      return 'status-badge status-badge--active';
    case 'paused':
      return 'status-badge status-badge--paused';
    case 'cancelled':
      return 'status-badge status-badge--cancelled';
    case 'completed':
      return 'status-badge status-badge--completed';
    case 'missed':
      return 'status-badge status-badge--warning';
    case 'insufficient_funds':
      return 'status-badge status-badge--danger';
    default:
      return 'status-badge';
  }
}

function streamStatusClass(status: StreamStatus): string {
  switch (status) {
    case 'completed':
      return 'status-badge status-badge--completed';
    case 'failed':
      return 'status-badge status-badge--danger';
    case 'cancelled':
      return 'status-badge status-badge--cancelled';
    case 'streaming':
      return 'status-badge status-badge--active';
    case 'funded':
      return 'status-badge status-badge--paused';
    default:
      return 'status-badge';
  }
}

export function DashboardView() {
  const { address, isConnected } = useWallet();
  const { network, expectedNetwork, isNetworkMismatch, switchNetwork } = useNetwork();

  const [loadState, setLoadState] = useState<LoadState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [schedules, setSchedules] = useState<ScheduleWithStreams[]>([]);
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    scheduleId: string;
    action: 'pause' | 'cancel';
  } | null>(null);

  const loadSchedules = useCallback(async () => {
    if (!isConnected || !address) {
      setSchedules([]);
      setLoadState('idle');
      return;
    }
    setLoadState('loading');
    setError(null);
    try {
      const fetched = await fetchRecurringSchedules(address);
      const withStreams = await Promise.all(
        fetched.map(async (schedule) => {
          const streams = await fetchScheduleStreams(schedule.id);
          return { schedule, streams };
        }),
      );
      setSchedules(withStreams);
      setLoadState('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recurring schedules.');
      setLoadState('error');
    }
  }, [address, isConnected]);

  useEffect(() => {
    void loadSchedules();
  }, [loadSchedules]);

  const handleConfirmAction = useCallback(async () => {
    if (!confirmAction) return;
    const { scheduleId, action } = confirmAction;
    setPendingActionId(scheduleId);
    setActionError(null);
    try {
      if (action === 'pause') {
        await pauseRecurringSchedule(scheduleId);
      } else {
        await cancelRecurringSchedule(scheduleId);
      }
      setConfirmAction(null);
      await loadSchedules();
    } catch (err) {
      setActionError(
        err instanceof Error
          ? err.message
          : `Failed to ${action} recurring schedule.`,
      );
    } finally {
      setPendingActionId(null);
    }
  }, [confirmAction, loadSchedules]);

  const totalFundingRequirement = useMemo(() => {
    return schedules
      .filter(({ schedule }) => schedule.status === 'active' || schedule.status === 'paused')
      .reduce((sum, { schedule }) => sum + Number(schedule.fundingRequirement || 0), 0);
  }, [schedules]);

  if (!isConnected) {
    return (
      <section className="dashboard-view" aria-labelledby="dashboard-heading">
        <h1 id="dashboard-heading">Dashboard</h1>
        <p className="dashboard-empty">Connect your wallet to view recurring payment schedules.</p>
      </section>
    );
  }

  if (isNetworkMismatch) {
    return (
      <section className="dashboard-view" aria-labelledby="dashboard-heading">
        <h1 id="dashboard-heading">Dashboard</h1>
        <div className="network-mismatch" role="alert">
          <h2>Wallet network mismatch</h2>
          <p>
            Your wallet is connected to <strong>{network}</strong>, but recurring payments
            require <strong>{expectedNetwork}</strong>.
          </p>
          <button type="button" className="btn btn--primary" onClick={() => void switchNetwork()}>
            Switch to {expectedNetwork}
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="dashboard-view" aria-labelledby="dashboard-heading">
      <header className="dashboard-header">
        <h1 id="dashboard-heading">Recurring payments</h1>
        <button
          type="button"
          className="btn btn--secondary"
          onClick={() => void loadSchedules()}
          disabled={loadState === 'loading'}
        >
          Refresh
        </button>
      </header>

      {loadState === 'loading' && <p className="dashboard-loading">Loading schedules…</p>}

      {loadState === 'error' && (
        <div className="dashboard-error" role="alert">
          <p>{error}</p>
          <button type="button" className="btn btn--secondary" onClick={() => void loadSchedules()}>
            Retry
          </button>
        </div>
      )}

      {actionError && (
        <div className="dashboard-error" role="alert">
          <p>{actionError}</p>
        </div>
      )}

      {loadState === 'ready' && schedules.length === 0 && (
        <p className="dashboard-empty">You have no recurring payment schedules yet.</p>
      )}

      {loadState === 'ready' && schedules.length > 0 && (
        <>
          <div className="dashboard-summary">
            <span>
              Total funding requirement:{' '}
              <strong>{totalFundingRequirement.toFixed(2)}</strong>
            </span>
          </div>

          <ul className="schedule-list">
            {schedules.map(({ schedule, streams }) => {
              const isPending = pendingActionId === schedule.id;
              const canPause = schedule.status === 'active';
              const canCancel =
                schedule.status === 'active' ||
                schedule.status === 'paused' ||
                schedule.status === 'missed' ||
                schedule.status === 'insufficient_funds';

              return (
                <li key={schedule.id} className="schedule-card">
                  <div className="schedule-card__header">
                    <div>
                      <h2 className="schedule-card__title">
                        {formatAmount(schedule.amount, schedule.asset)} every{' '}
                        {schedule.interval}
                      </h2>
                      <span className={statusClass(schedule.status)}>
                        {STATUS_LABELS[schedule.status]}
                      </span>
                    </div>
                    <div className="schedule-card__actions">
                      {canPause && (
                        <button
                          type="button"
                          className="btn btn--secondary"
                          disabled={isPending}
                          onClick={() =>
                            setConfirmAction({ scheduleId: schedule.id, action: 'pause' })
                          }
                        >
                          Pause
                        </button>
                      )}
                      {canCancel && (
                        <button
                          type="button"
                          className="btn btn--danger"
                          disabled={isPending}
                          onClick={() =>
                            setConfirmAction({ scheduleId: schedule.id, action: 'cancel' })
                          }
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>

                  <dl className="schedule-card__details">
                    <div>
                      <dt>Next run</dt>
                      <dd>{formatDateTime(schedule.nextRunAt)}</dd>
                    </div>
                    <div>
                      <dt>Funding requirement</dt>
                      <dd>{formatAmount(schedule.fundingRequirement, schedule.asset)}</dd>
                    </div>
                    <div>
                      <dt>Recipient</dt>
                      <dd className="mono">{schedule.recipient}</dd>
                    </div>
                  </dl>

                  {schedule.status === 'missed' && (
                    <div className="schedule-alert schedule-alert--warning" role="status">
                      A scheduled run was missed on {formatDateTime(schedule.lastRunAt)}. Ensure
                      your wallet is funded before the next run.
                    </div>
                  )}

                  {schedule.status === 'insufficient_funds' && (
                    <div className="schedule-alert schedule-alert--danger" role="alert">
                      Insufficient funds to cover the next run of{' '}
                      {formatAmount(schedule.fundingRequirement, schedule.asset)}. Top up your
                      wallet to keep this schedule active.
                    </div>
                  )}

                  <div className="schedule-card__streams">
                    <h3>Payment obligations</h3>
                    {streams.length === 0 ? (
                      <p className="dashboard-empty">No streams generated yet.</p>
                    ) : (
                      <ul className="stream-list">
                        {streams.map((stream) => (
                          <li key={stream.id} className="stream-item">
                            <div className="stream-item__row">
                              <span className={streamStatusClass(stream.status)}>
                                {STREAM_STATUS_LABELS[stream.status]}
                              </span>
                              <span className="stream-item__amount">
                                {formatAmount(stream.amount, stream.asset)}
                              </span>
                            </div>
                            <div className="stream-item__row stream-item__meta">
                              <span>Scheduled: {formatDateTime(stream.scheduledAt)}</span>
                              {stream.executedAt && (
                                <span>Executed: {formatDateTime(stream.executedAt)}</span>
                              )}
                            </div>
                            <div className="stream-item__row stream-item__meta">
                              <span>
                                Tx:{' '}
                                {stream.txHash ? (
                                  <span className="mono">{stream.txHash}</span>
                                ) : (
                                  '—'
                                )}
                              </span>
                            </div>
                            {stream.status === 'failed' && stream.failureReason && (
                              <p className="stream-item__error" role="alert">
                                {stream.failureReason}
                              </p>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {confirmAction && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-action-heading"
          >
            <h2 id="confirm-action-heading">
              {confirmAction.action === 'pause' ? 'Pause schedule?' : 'Cancel schedule?'}
            </h2>
            <p>
              {confirmAction.action === 'pause'
                ? 'Pausing will stop future runs until you resume the schedule.'
                : 'Cancelling is permanent and will stop all future runs for this schedule.'}
            </p>
            <div className="modal__actions">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setConfirmAction(null)}
                disabled={pendingActionId !== null}
              >
                Keep schedule
              </button>
              <button
                type="button"
                className={
                  confirmAction.action === 'cancel' ? 'btn btn--danger' : 'btn btn--primary'
                }
                onClick={() => void handleConfirmAction()}
                disabled={pendingActionId !== null}
              >
                {pendingActionId !== null
                  ? 'Processing…'
                  : confirmAction.action === 'pause'
                    ? 'Pause schedule'
                    : 'Cancel schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default DashboardView;