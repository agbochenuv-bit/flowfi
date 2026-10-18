/**
 * Content Security Policy and HTTP Security Headers Configuration
 *
 * Implements a restrictive, deployment-aware security policy:
 * - Differentiates between production, preview, and local development origins
 * - Grants explicit network access to Soroban RPC, Stellar Horizon, and backend API/SSE endpoints
 * - Permits wallet provider injection (e.g. Freighter, xBull, Albedo) via browser extension protocols and known wallet frames
 * - Avoids broadly enabling unsafe sources (avoids `unsafe-inline` where possible, restricts script execution)
 */

export interface SecurityHeadersConfig {
  env?: string;
  isDev?: boolean;
  isPreview?: boolean;
  apiUrl?: string;
  sseUrl?: string;
  horizonUrl?: string;
  sorobanRpcUrl?: string;
}

/**
 * Builds the Content-Security-Policy directive map and serializes to a policy string.
 */
export function buildCspDirectives(config: SecurityHeadersConfig = {}): string {
  const isDev = config.isDev ?? (process.env.NODE_ENV === 'development');
  const isPreview = config.isPreview ?? (process.env.VERCEL_ENV === 'preview' || process.env.NEXT_PUBLIC_VERCEL_ENV === 'preview');

  const apiUrl = config.apiUrl || process.env.NEXT_PUBLIC_API_URL || '';
  const sseUrl = config.sseUrl || process.env.NEXT_PUBLIC_SSE_URL || '';
  const horizonUrl = config.horizonUrl || process.env.NEXT_PUBLIC_STELLAR_HORIZON_URL || '';
  const sorobanRpcUrl = config.sorobanRpcUrl || process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || '';

  // Core connect-src sources
  const connectSources = new Set<string>([
    "'self'",
    'https://*.stellar.org',
    'https://horizon.stellar.org',
    'https://horizon-testnet.stellar.org',
    'https://soroban-testnet.stellar.org',
    'https://rpc-futurenet.stellar.org',
    // Wallet provider extension communication
    'chrome-extension:',
    'moz-extension:',
  ]);

  if (apiUrl) {
    try {
      const parsed = new URL(apiUrl);
      connectSources.add(parsed.origin);
    } catch {
      connectSources.add(apiUrl);
    }
  }

  if (sseUrl) {
    try {
      const parsed = new URL(sseUrl);
      connectSources.add(parsed.origin);
    } catch {
      connectSources.add(sseUrl);
    }
  }

  if (horizonUrl) {
    try {
      const parsed = new URL(horizonUrl);
      connectSources.add(parsed.origin);
    } catch {
      connectSources.add(horizonUrl);
    }
  }

  if (sorobanRpcUrl) {
    try {
      const parsed = new URL(sorobanRpcUrl);
      connectSources.add(parsed.origin);
    } catch {
      connectSources.add(sorobanRpcUrl);
    }
  }

  // Development and Preview allowances
  if (isDev) {
    connectSources.add('http://localhost:*');
    connectSources.add('http://127.0.0.1:*');
    connectSources.add('ws://localhost:*');
    connectSources.add('ws://127.0.0.1:*');
  } else if (isPreview) {
    connectSources.add('https://*.vercel.app');
  }

  // Script sources: Next.js requires 'unsafe-inline' without nonce middleware,
  // and 'wasm-unsafe-eval' for Soroban / Stellar WebAssembly modules.
  const scriptSources = [
    "'self'",
    "'wasm-unsafe-eval'",
    // In dev mode Next.js requires 'unsafe-eval' for fast refresh
    ...(isDev ? ["'unsafe-eval'"] : []),
    "'unsafe-inline'",
  ];

  // Frame sources: Embedded wallet providers such as Albedo and WalletConnect
  const frameSources = [
    "'self'",
    'https://albedo.link',
    'https://verify.walletconnect.com',
    'https://verify.walletconnect.org',
  ];

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': scriptSources,
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': Array.from(connectSources),
    'frame-src': frameSources,
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'none'"],
  };

  if (!isDev) {
    directives['upgrade-insecure-requests'] = [];
  }

  return Object.entries(directives)
    .map(([key, values]) => {
      if (values.length === 0) return key;
      return `${key} ${values.join(' ')}`;
    })
    .join('; ');
}

/**
 * Generates the full set of standard security headers for Next.js configuration.
 */
export function getSecurityHeaders(config: SecurityHeadersConfig = []): Array<{ key: string; value: string }> {
  const csp = buildCspDirectives(config);

  return [
    {
      key: 'Content-Security-Policy',
      value: csp,
    },
    {
      key: 'X-Frame-Options',
      value: 'DENY',
    },
    {
      key: 'X-Content-Type-Options',
      value: 'nosniff',
    },
    {
      key: 'Referrer-Policy',
      value: 'strict-origin-when-cross-origin',
    },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
    },
    {
      key: 'Strict-Transport-Security',
      value: 'max-age=63072000; includeSubDomains; preload',
    },
    {
      key: 'X-DNS-Prefetch-Control',
      value: 'on',
    },
  ];
}
