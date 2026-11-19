import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWallet } from '../../hooks/useWallet';
import { useStreams } from '../../hooks/useStreams';
import { useRecurringSchedules } from '../../hooks/useRecurringSchedules';
import { createRecurringSchedule } from '../../services/recurringSchedules';
import { validateWalletNetwork } from '../../services/walletNetwork';
import { formatAmount, formatDate } from '../../utils/format';
import { StreamCreationStep } from './StreamCreationStep';
import { StreamReviewStep } from './StreamReviewStep';
import { ScheduleReviewStep } from './ScheduleReviewStep';
import { StreamConfirmationStep } from './StreamConfirmationStep';
import { ErrorBanner } from '../common/ErrorBanner';
import type {
  RecurringScheduleDraft,
  StreamDraft,
  WizardStep,
} from '../../types/streamCreation';

interface StreamCreationWizardProps {
  onClose?: () => void;
  onCreated?: (streamId: string) => void;
  onScheduleCreated?: (scheduleId: string) => void;
}

type CreationMode = 'one-off' | 'recurring';

const DEFAULT_RECURRING_DRAFT: RecurringScheduleDraft = {
  recipient: '',
  amount: '',
  asset: 'XLM',
  intervalSeconds: 30 * 24 * 60 * 60,
  startAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  totalRuns: 12,
  memo: '',
};

export const StreamCreationWizard: React.FC<StreamCreationWizardProps> = ({
  onClose,
  onCreated,
  onScheduleCreated,
}) => {
  const { address, network, isConnected } = useWallet();
  const { createStream } = useStreams();
  const { refresh: refreshSchedules } = useRecurringSchedules();

  const [step, setStep] = useState<WizardStep>('details');
  const [mode, setMode] = useState<CreationMode>('one-off');
  const [streamDraft, setStreamDraft] = useState<StreamDraft | null>(null);
  const [recurringDraft, setRecurringDraft] =
    useState<RecurringScheduleDraft>(DEFAULT_RECURRING_DRAFT);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  useEffect(() => {
    // Reset transient error state when the user moves between steps.
    setError(null);
  }, [step]);

  const fundingRequirement = useMemo(() => {
    if (mode !== 'recurring') return null;
    const amount = Number(recurringDraft.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const runs = Math.max(0, Math.floor(recurringDraft.totalRuns));
    return {
      perRun: amount,
      totalRuns: runs,
      totalRequired: amount * runs,
      asset: recurringDraft.asset,
    };
  }, [mode, recurringDraft.amount, recurringDraft.totalRuns, recurringDraft.asset]);

  const nextRunAt = useMemo(() => {
    if (mode !== 'recurring') return null;
    return recurringDraft.startAt;
  }, [mode, recurringDraft.startAt]);

  const handleModeChange = useCallback((nextMode: CreationMode) => {
    setMode(nextMode);
    setError(null);
  }, []);

  const handleStreamDraftChange = useCallback((draft: StreamDraft) => {
    setStreamDraft(draft);
  }, []);

  const handleRecurringDraftChange = useCallback(
    (patch: Partial<RecurringScheduleDraft>) => {
      setRecurringDraft((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const handleContinueFromDetails = useCallback(() => {
    if (!isConnected || !address) {
      setError('Connect your wallet before continuing.');
      return;
    }
    if (mode === 'one-off') {
      if (!streamDraft) {
        setError('Please complete the stream details.');
        return;
      }
      setStep('review');
      return;
    }
    if (!recurringDraft.recipient || !recurringDraft.amount) {
      setError('Please complete the schedule details.');
      return;
    }
    if (Number(recurringDraft.amount) <= 0) {
      setError('Amount must be greater than zero.');
      return;
    }
    if (recurringDraft.totalRuns < 1) {
      setError('A recurring schedule must run at least once.');
      return;
    }
    setStep('review');
  }, [address, isConnected, mode, streamDraft, recurringDraft]);

  const handleConfirmOneOff = useCallback(async () => {
    if (!streamDraft) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const stream = await createStream(streamDraft);
      setCreatedId(stream.id);
      setStep('confirmation');
      onCreated?.(stream.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create stream.');
    } finally {
      setIsSubmitting(false);
    }
  }, [streamDraft, createStream, onCreated]);

  const handleConfirmRecurring = useCallback(async () => {
    if (!address) {
      setError('Connect your wallet before continuing.');
      setStep('details');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Validate the wallet is on the expected network before submitting.
      const networkCheck = await validateWalletNetwork(network);
      if (!networkCheck.ok) {
        setError(
          networkCheck.message ??
            'Your wallet network does not match the required network. Please switch networks and try again.',
        );
        setStep('details');
        return;
      }

      const schedule = await createRecurringSchedule({
        ...recurringDraft,
        owner: address,
        network,
      });

      setCreatedId(schedule.id);
      setStep('confirmation');
      await refreshSchedules();
      onScheduleCreated?.(schedule.id);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create recurring schedule.';
      const code = (err as { code?: string } | undefined)?.code;

      if (code === 'INSUFFICIENT_FUNDS' || /insufficient funds/i.test(message)) {
        setError(
          'Insufficient funds to fund the recurring schedule. Add funds or reduce the amount/total runs, then try again.',
        );
        setStep('details');
        return;
      }

      if (
        code === 'NETWORK_MISMATCH' ||
        /network mismatch|wrong network/i.test(message)
      ) {
        setError(
          'Your wallet network does not match the required network. Please switch networks and try again.',
        );
        setStep('details');
        return;
      }

      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    address,
    network,
    recurringDraft,
    refreshSchedules,
    onScheduleCreated,
  ]);

  const handleBack = useCallback(() => {
    setError(null);
    setStep('details');
  }, []);

  const handleClose = useCallback(() => {
    onClose?.();
  }, [onClose]);

  return (
    <div className="stream-creation-wizard">
      <header className="stream-creation-wizard__header">
        <h2>Create a payment</h2>
        <button
          type="button"
          className="stream-creation-wizard__close"
          onClick={handleClose}
          aria-label="Close"
        >
          ×
        </button>
      </header>

      {step === 'details' && (
        <div className="stream-creation-wizard__mode">
          <fieldset>
            <legend>Payment type</legend>
            <label>
              <input
                type="radio"
                name="creation-mode"
                value="one-off"
                checked={mode === 'one-off'}
                onChange={() => handleModeChange('one-off')}
              />
              One-off stream
            </label>
            <label>
              <input
                type="radio"
                name="creation-mode"
                value="recurring"
                checked={mode === 'recurring'}
                onChange={() => handleModeChange('recurring')}
              />
              Recurring schedule
            </label>
          </fieldset>
        </div>
      )}

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {step === 'details' && mode === 'one-off' && (
        <StreamCreationStep
          draft={streamDraft}
          onChange={handleStreamDraftChange}
          onContinue={handleContinueFromDetails}
        />
      )}

      {step === 'details' && mode === 'recurring' && (
        <StreamCreationStep
          mode="recurring"
          recurringDraft={recurringDraft}
          onRecurringChange={handleRecurringDraftChange}
          onContinue={handleContinueFromDetails}
        />
      )}

      {step === 'review' && mode === 'one-off' && streamDraft && (
        <StreamReviewStep
          draft={streamDraft}
          isSubmitting={isSubmitting}
          onBack={handleBack}
          onConfirm={handleConfirmOneOff}
        />
      )}

      {step === 'review' && mode === 'recurring' && (
        <ScheduleReviewStep
          draft={recurringDraft}
          nextRunAt={nextRunAt}
          fundingRequirement={fundingRequirement}
          isSubmitting={isSubmitting}
          onBack={handleBack}
          onConfirm={handleConfirmRecurring}
        />
      )}

      {step === 'confirmation' && createdId && (
        <StreamConfirmationStep
          id={createdId}
          mode={mode}
          onClose={handleClose}
        />
      )}
    </div>
  );
};

export default StreamCreationWizard;