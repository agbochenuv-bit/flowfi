import { renderHook, act, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletProvider, useWallet } from './wallet-context';
import type { WalletSession } from '@/lib/wallet';

const STORAGE_KEY = 'flowfi.wallet.session.v1';

const mockSession: WalletSession = {
  walletId: 'freighter',
  walletName: 'Freighter',
  publicKey: 'GABC1234567890DEF',
  connectedAt: new Date().toISOString(),
  network: 'Testnet',
  mocked: false,
};
const AUTH_STORAGE_KEY = 'flowfi.wallet.auth.v1';
const VALID_TOKEN = 'e30.eyJleHAiOjQxMDI0NDQ4MDB9.sig';

vi.mock('@/lib/wallet', () => ({
  SUPPORTED_WALLETS: [
    {
      id: 'freighter',
      name: 'Freighter',
      badge: 'Extension',
      description: 'Direct browser wallet',
    },
  ],
  connectWallet: vi.fn(),
  toWalletErrorMessage: vi.fn((error: unknown) =>
    error instanceof Error ? error.message : 'Wallet connection failed'
  ),
  authenticateWallet: vi.fn().mockResolvedValue('e30.eyJleHAiOjQxMDI0NDQ4MDB9.sig'),
  getConnectedWalletAddress: vi.fn().mockResolvedValue('GABC1234567890DEF'),
}));

function createWrapper() {
  return function Wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
      <QueryClientProvider client={client}>
        <WalletProvider>{children}</WalletProvider>
      </QueryClientProvider>
    );
  };
}

describe('WalletProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('hydrate', () => {
    it('should restore a valid stored session as connected', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ publicKey: mockSession.publicKey, token: VALID_TOKEN }));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
      expect(result.current.authToken).toBe(VALID_TOKEN);
    });

    it('should discard a malformed session', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ invalid: true }));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });

    it('should recover from syntactically invalid stored JSON without crashing', async () => {
      localStorage.setItem(STORAGE_KEY, '{not valid json,,,');

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(result.current.errorMessage).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('should discard a stored session that parses to a non-object value', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify('just-a-string'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('should discard a session with mocked !== false', async () => {
      const mockedSession = { ...mockSession, mocked: true };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockedSession));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
    });
  });

  describe('connect', () => {
    it('should dispatch connect:success and store session on success', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValue(mockSession);

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('connected');
      expect(result.current.session).toEqual(mockSession);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(JSON.stringify(mockSession));
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toContain(VALID_TOKEN);
    });

    it('should dispatch connect:error and clear stored session on failure', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockRejectedValue(new Error('Connection failed'));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await act(async () => {
        await result.current.connect('freighter');
      });

      expect(result.current.status).toBe('error');
      expect(result.current.errorMessage).toBe('Connection failed');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    });
  });

  describe('disconnect', () => {
    it('should clear state and remove localStorage key', async () => {
      const { connectWallet } = await import('@/lib/wallet');
      vi.mocked(connectWallet).mockResolvedValue(mockSession);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockSession));
      localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ publicKey: mockSession.publicKey, token: VALID_TOKEN }));

      const { result } = renderHook(() => useWallet(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isHydrated).toBe(true);
      });

      act(() => {
        result.current.disconnect();
      });

      expect(result.current.status).toBe('idle');
      expect(result.current.session).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    });
  });

  describe('useWallet outside provider', () => {
    it('should throw when used outside WalletProvider', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      expect(() => {
        renderHook(() => useWallet());
      }).toThrow('useWallet must be used within WalletProvider.');

      consoleSpy.mockRestore();
    });
  });
});
