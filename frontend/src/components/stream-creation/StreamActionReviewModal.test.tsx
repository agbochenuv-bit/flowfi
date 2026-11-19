import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import StreamActionReviewModal from './StreamActionReviewModal';

// Mock the soroban fee-estimate helper used by the modal.
vi.mock('../../lib/soroban/feeEstimate', () => ({
  estimateTransactionFee: vi.fn(),
}));

import { estimateTransactionFee } from '../../lib/soroban/feeEstimate';

const mockedEstimate = vi.mocked(estimateTransactionFee);

type FeeEstimateResult =
  | {
      status: 'ok';
      baseFee: string;
      totalFee: string;
      congestion: 'low' | 'medium' | 'high';
      fetchedAt: number;
    }
  | { status: 'unavailable'; reason: string };

function okEstimate(overrides: Partial<Extract<FeeEstimateResult, { status: 'ok' }>> = {}) {
  return {
    status: 'ok' as const,
    baseFee: '100',
    totalFee: '250',
    congestion: 'low' as const,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

const defaultProps = {
  open: true,
  action: 'create' as const,
  streamSummary: {
    recipient: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    amount: '1000',
    asset: 'XLM',
  },
  onConfirm: vi.fn(),
  onCancel: vi.fn(),
};

describe('StreamActionReviewModal cost & congestion review', () => {
  beforeEach(() => {
    mockedEstimate.mockReset();
    defaultProps.onConfirm.mockReset();
    defaultProps.onCancel.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  it('renders the unavailable state without a numeric fee when RPC is unavailable', async () => {
    mockedEstimate.mockResolvedValue({
      status: 'unavailable',
      reason: 'RPC endpoint unreachable',
    } as FeeEstimateResult);

    render(<StreamActionReviewModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('fee-estimate-unavailable')).toBeInTheDocument();
    });

    // Clearly labeled as unavailable / not an estimate.
    expect(screen.getByText(/fee estimate unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/RPC endpoint unreachable/i)).toBeInTheDocument();

    // No numeric fee should be shown.
    expect(screen.queryByTestId('fee-estimate-total')).not.toBeInTheDocument();
    expect(screen.queryByTestId('fee-estimate-base')).not.toBeInTheDocument();
    expect(screen.queryByText(/250/)).not.toBeInTheDocument();

    // Confirm should still be gated/available per component contract but must not
    // fabricate a fee. We only assert no numeric fee is displayed here.
  });

  it('updates the displayed estimate and marks older data stale when fee estimates change', async () => {
    const firstFetchedAt = Date.now() - 60_000;
    mockedEstimate.mockResolvedValueOnce(
      okEstimate({ totalFee: '250', baseFee: '100', congestion: 'low', fetchedAt: firstFetchedAt }) as FeeEstimateResult,
    );

    render(<StreamActionReviewModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('fee-estimate-total')).toHaveTextContent('250');
    });

    // Estimate is clearly labeled as an estimate.
    expect(screen.getByText(/estimated fee/i)).toBeInTheDocument();
    expect(screen.getByTestId('fee-estimate-total')).toBeInTheDocument();

    // Now a new estimate arrives (e.g. via refresh / polling).
    mockedEstimate.mockResolvedValueOnce(
      okEstimate({ totalFee: '400', baseFee: '150', congestion: 'high', fetchedAt: Date.now() }) as FeeEstimateResult,
    );

    const refreshButton = screen.queryByTestId('fee-estimate-refresh');
    if (refreshButton) {
      await act(async () => {
        fireEvent.click(refreshButton);
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId('fee-estimate-total')).toHaveTextContent('400');
    });

    // The previous estimate should be marked stale (label present).
    expect(screen.getByTestId('fee-estimate-stale')).toBeInTheDocument();
    expect(screen.getByText(/stale/i)).toBeInTheDocument();

    // Congestion context is surfaced.
    expect(screen.getByTestId('congestion-indicator')).toBeInTheDocument();
  });

  it('closes the modal without invoking onConfirm when the user cancels', async () => {
    mockedEstimate.mockResolvedValue(okEstimate() as FeeEstimateResult);

    render(<StreamActionReviewModal {...defaultProps} />);

    await waitFor(() => {
      expect(screen.getByTestId('fee-estimate-total')).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    fireEvent.click(cancelButton);

    expect(defaultProps.onCancel).toHaveBeenCalledTimes(1);
    expect(defaultProps.onConfirm).not.toHaveBeenCalled();
  });
});