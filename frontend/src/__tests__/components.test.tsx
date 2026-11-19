import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';

vi.mock('next/navigation', () => ({ useRouter: vi.fn() }));
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn(), loading: vi.fn() },
}));

// Import after vi.mock registrations
import { CancelConfirmModal } from '../components/stream-creation/CancelConfirmModal';
import { RecipientStep } from '../components/stream-creation/RecipientStep';
import { AmountStep } from '../components/stream-creation/AmountStep';
import { StreamChangePreview } from '../components/stream-creation/StreamChangePreview';
import { AssetBadge } from '../components/stream-creation/AssetBadge';

// ─── CancelConfirmModal ───────────────────────────────────────────────────────

// Stub Button so we don't need the full UI library in tests
vi.mock('../components/ui/Button', () => ({
  Button: ({ children, onClick, disabled }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

describe('CancelConfirmModal', () => {
  const baseProps = {
    streamId: 'stream-42',
    recipient: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
    token: 'USDC',
    deposited: 1000,
    withdrawn: 200,
    onConfirm: vi.fn().mockResolvedValue(undefined),
    onClose: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders stream details correctly', () => {
    render(<CancelConfirmModal {...baseProps} />);
    expect(screen.getByText('Cancel Stream?')).toBeInTheDocument();
    expect(screen.getByText('stream-42')).toBeInTheDocument();
  });

  it('calls onClose when "Keep Stream" button is clicked', () => {
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.click(screen.getByText('Keep Stream'));
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onConfirm with streamId when "Yes, Cancel Stream" is clicked', async () => {
    render(<CancelConfirmModal {...baseProps} />);
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, Cancel Stream'));
    });
    expect(baseProps.onConfirm).toHaveBeenCalledWith('stream-42');
  });

  it('calls onClose when Escape key is pressed', () => {
    render(<CancelConfirmModal {...baseProps} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseProps.onClose).toHaveBeenCalledTimes(1);
  });

  it('does not call onClose when Escape key is pressed while submitting', async () => {
    let resolveConfirm!: () => void;
    const slowConfirm = vi.fn(
      () => new Promise<void>((res) => { resolveConfirm = res; }),
    );
    render(<CancelConfirmModal {...baseProps} onConfirm={slowConfirm} />);

    // Trigger the submit to enter submitting state
    await act(async () => {
      fireEvent.click(screen.getByText('Yes, Cancel Stream'));
    });

    // Component is in submitting state — Escape should be ignored
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(baseProps.onClose).not.toHaveBeenCalled();

    // Resolve and clean up
    await act(async () => { resolveConfirm(); });
  });

  it('shows remaining = deposited - withdrawn', () => {
    render(<CancelConfirmModal {...baseProps} />);
    // remaining = 1000 - 200 = 800
    const matches = screen.getAllByText(/800/);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0]).toBeInTheDocument();
  });
});

// ─── RecipientStep ────────────────────────────────────────────────────────────

describe('RecipientStep', () => {
  const VALID_KEY = 'GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7';
  const INVALID_CHECKSUM = 'GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR8';

  it('renders the input field', () => {
    render(<RecipientStep value="" onChange={vi.fn()} />);
    expect(screen.getByPlaceholderText(/GABCDEF/i)).toBeInTheDocument();
  });

  it('calls onChange when the user types', () => {
    const onChange = vi.fn();
    render(<RecipientStep value="" onChange={onChange} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'GABC' } });
    expect(onChange).toHaveBeenCalledWith('GABC');
  });

  it('shows the error message when error prop is provided', () => {
    render(<RecipientStep value="" onChange={vi.fn()} error="Invalid key" />);
    expect(screen.getByText('Invalid key')).toBeInTheDocument();
  });

  it('does not show an error when error prop is absent', () => {
    render(<RecipientStep value="" onChange={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an inline error in real time for an invalid checksum', () => {
    render(<RecipientStep value={INVALID_CHECKSUM} onChange={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Invalid Stellar public key (must start with 'G' and be 56 characters)",
    );
  });

  it('shows no error for a valid recipient key', () => {
    render(<RecipientStep value={VALID_KEY} onChange={vi.fn()} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('trims whitespace from pasted values', () => {
    const onChange = vi.fn();
    render(<RecipientStep value="" onChange={onChange} />);
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { getData: () => `  ${VALID_KEY}  ` },
    });
    expect(onChange).toHaveBeenCalledWith(VALID_KEY);
  });

  it('trims whitespace on blur', () => {
    const onChange = vi.fn();
    render(<RecipientStep value={`  ${VALID_KEY}  `} onChange={onChange} />);
    fireEvent.blur(screen.getByRole('textbox'));
    expect(onChange).toHaveBeenCalledWith(VALID_KEY);
  });
});

// ─── AmountStep ──────────────────────────────────────────────────────────────

describe('AmountStep', () => {
  it('renders the amount input', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="USDC" />);
    expect(screen.getByRole('spinbutton')).toBeInTheDocument();
  });

  it('calls onChange when value changes', () => {
    const onChange = vi.fn();
    render(<AmountStep value="" onChange={onChange} token="USDC" />);
    fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '50' } });
    expect(onChange).toHaveBeenCalledWith('50');
  });

  it('shows an error message when error prop is provided', () => {
    render(<AmountStep value="" onChange={vi.fn()} error="Amount too low" />);
    expect(screen.getByText('Amount too low')).toBeInTheDocument();
  });

  it('calls onSetMax when Max button is clicked', () => {
    const onSetMax = vi.fn();
    render(
      <AmountStep
        value=""
        onChange={vi.fn()}
        token="USDC"
        availableBalance="100"
        onSetMax={onSetMax}
      />,
    );
    fireEvent.click(screen.getByText('Max'));
    expect(onSetMax).toHaveBeenCalledTimes(1);
  });

  it('Max button is disabled when no balance is available', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="USDC" availableBalance={null} />);
    expect(screen.getByText('Max')).toBeDisabled();
  });

  it('shows a preview when a positive amount is entered without errors', () => {
    render(<AmountStep value="25" onChange={vi.fn()} token="XLM" />);
    expect(screen.getByText(/25 XLM/i)).toBeInTheDocument();
  });

  it('shows the available spendable balance', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="USDC" availableBalance="100" />);
    expect(screen.getByText(/Available: 100 USDC/)).toBeInTheDocument();
  });

  it('shows the reduced available balance and reserve note for XLM', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="XLM" availableBalance="100" />);
    expect(screen.getByText(/Available: 99 XLM/)).toBeInTheDocument();
    expect(screen.getByText(/kept in reserve/i)).toBeInTheDocument();
  });

  it('shows an inline error when the amount exceeds the wallet balance', () => {
    render(<AmountStep value="150" onChange={vi.fn()} token="USDC" availableBalance="100" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Amount exceeds wallet balance');
  });

  it('disables Max when the spendable balance is zero (XLM reserve)', () => {
    render(<AmountStep value="" onChange={vi.fn()} token="XLM" availableBalance="1" />);
    expect(screen.getByText('Max')).toBeDisabled();
  });
});

// ─── StreamChangePreview ─────────────────────────────────────────────────────

describe('StreamChangePreview', () => {
  const baseStream = {
    streamId: 'stream-7',
    token: 'USDC',
    deposited: '1000.0000000',
    withdrawn: '200.0000000',
    ratePerSecond: '0.0000115740740',
    recipient: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };

  it('renders before and after columns for a top-up', () => {
    render(
      <StreamChangePreview
        change={{ kind: 'top-up', amount: '250' }}
        stream={baseStream}
      />,
    );
    expect(screen.getByText(/before/i)).toBeInTheDocument();
    expect(screen.getByText(/after/i)).toBeInTheDocument();
    expect(screen.getByText(/1,250/)).toBeInTheDocument();
  });

  it('rounds displayed amounts to the token precision and labels the assumption', () => {
    render(
      <StreamChangePreview
        change={{ kind: 'top-up', amount: '0.123456789' }}
        stream={{ ...baseStream, deposited: '1000.0000000' }}
      />,
    );
    // 7-decimal precision: 0.1234567 (truncated/rounded), never more than 7 dp
    const after = screen.getByTestId('preview-after-deposited');
    expect(after.textContent).toMatch(/1,000\.1234567/);
    expect(after.textContent).not.toMatch(/\d{8,}/);
    expect(screen.getByText(/rounded to 7 decimal places/i)).toBeInTheDocument();
  });

  it('flags stale stream state when the stream was updated after the preview snapshot', () => {
    render(
      <StreamChangePreview
        change={{ kind: 'top-up', amount: '10' }}
        stream={baseStream}
        snapshotUpdatedAt="2023-12-31T00:00:00.000Z"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/stream has changed/i);
  });

  it('does not flag stale state when the snapshot matches the stream', () => {
    render(
      <StreamChangePreview
        change={{ kind: 'top-up', amount: '10' }}
        stream={baseStream}
        snapshotUpdatedAt={baseStream.updatedAt}
      />,
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('prompts the user to reconnect when the wallet is canceled', () => {
    render(
      <StreamChangePreview
        change={{ kind: 'cancel' }}
        stream={baseStream}
        walletStatus="canceled"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/wallet connection was canceled/i);
    expect(screen.getByText(/reconnect/i)).toBeInTheDocument();
  });

  it('renders a cancellation preview showing the remaining balance', () => {
    render(
      <StreamChangePreview change={{ kind: 'cancel' }} stream={baseStream} />,
    );
    expect(screen.getByTestId('preview-after-deposited')).toHaveTextContent(/800/);
  });

  it('renders a beneficiary change preview with both addresses', () => {
    const newRecipient = 'GAV4A377RAEV6YVAWZVHXF4VZD5ZBXGIKEMNHV5YIMV5LIKSNQVYUBR7';
    render(
      <StreamChangePreview
        change={{ kind: 'beneficiary', recipient: newRecipient }}
        stream={baseStream}
      />,
    );
    expect(screen.getByText(baseStream.recipient)).toBeInTheDocument();
    expect(screen.getByText(newRecipient)).toBeInTheDocument();
  });
});

// ─── AssetBadge ──────────────────────────────────────────────────────────────

describe('AssetBadge', () => {
  it('shows a verified badge for a verified asset', () => {
    render(
      <AssetBadge
        asset={{
          code: 'USDC',
          issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          status: 'verified',
          network: 'mainnet',
        }}
      />,
    );
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
  });

  it('shows a deprecated badge for a deprecated asset', () => {
    render(
      <AssetBadge
        asset={{
          code: 'OLD',
          issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          status: 'deprecated',
          network: 'mainnet',
        }}
      />,
    );
    expect(screen.getByText(/deprecated/i)).toBeInTheDocument();
  });

  it('shows an unverified badge and preserves the raw issuer identifier', () => {
    const issuer = 'GUNKNOWNISSUER000000000000000000000000000000000000000000';
    render(
      <AssetBadge
        asset={{ code: 'XYZ', issuer, status: 'unverified', network: 'testnet' }}
      />,
    );
    expect(screen.getByText(/unverified/i)).toBeInTheDocument();
    expect(screen.getByText(issuer)).toBeInTheDocument();
  });

  it('handles unknown metadata without hiding the raw code and issuer', () => {
    const issuer = 'GRAWMETADATA0000000000000000000000000000000000000000000';
    render(<AssetBadge asset={{ code: 'RAW', issuer, status: 'unknown' }} />);
    expect(screen.getByText(/unknown/i)).toBeInTheDocument();
    expect(screen.getByText('RAW')).toBeInTheDocument();
    expect(screen.getByText(issuer)).toBeInTheDocument();
  });

  it('shows a blocked badge and keeps the raw identifiers visible', () => {
    const issuer = 'GBLOCKED00000000000000000000000000000000000000000000000';
    render(
      <AssetBadge
        asset={{ code: 'BLK', issuer, status: 'blocked', network: 'mainnet' }}
      />,
    );
    expect(screen.getByText(/blocked/i)).toBeInTheDocument();
    expect(screen.getByText('BLK')).toBeInTheDocument();
    expect(screen.getByText(issuer)).toBeInTheDocument();
  });

  it('displays the network-specific address when provided', () => {
    render(
      <AssetBadge
        asset={{
          code: 'USDC',
          issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
          status: 'verified',
          network: 'testnet',
          contractAddress: 'CABCDEF1234567890',
        }}
      />,
    );
    expect(screen.getByText(/testnet/i)).toBeInTheDocument();
    expect(screen.getByText('CABCDEF1234567890')).toBeInTheDocument();
  });
});
