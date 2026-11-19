/**
 * Verified Stellar asset metadata.
 *
 * Token metadata (symbol, name, decimals, icon) changes very rarely, which is
 * exactly why `/v1/tokens` can be served with an aggressive `Cache-Control` and
 * an `ETag`: once a dashboard has the list it can revalidate with a single
 * cheap conditional request instead of refetching on every route transition.
 *
 * The store is deliberately small and in-memory — there are only a handful of
 * verified assets per network. `updatedAt` bumps on any mutation so the route's
 * ETag changes and previously cached responses are revalidated (and therefore
 * invalidated) cleanly.
 */

/**
 * Trust level attached to a piece of token metadata. Clients use this to
 * distinguish authoritative data from hints and to decide whether to warn the
 * user before acting on it.
 *
 * - `verified`: curated by FlowFi and confirmed against the network.
 * - `cached`: previously verified, served from cache within its freshness TTL.
 * - `fallback`: a built-in default used because the primary source was
 *   unavailable or malformed. Safe for display, not authoritative.
 * - `unknown`: no usable metadata; only the raw on-chain amount is reliable.
 */
export type TokenTrustLevel = 'verified' | 'cached' | 'fallback' | 'unknown';

/** Where a token's metadata came from. */
export type TokenMetadataSource =
  | 'curated'
  | 'cache'
  | 'env_override'
  | 'default'
  | 'unavailable';

export interface TokenMetadata {
  /** Ticker used across the API and UI, e.g. `USDC`. */
  symbol: string;
  /** Human-readable asset name. */
  name: string;
  /** Number of decimal places the contract uses (Stellar assets use 7). */
  decimals: number;
  /** `native` for XLM, otherwise the Soroban contract address (C…). */
  contractAddress: string;
  /** Display/rounding type. */
  type: 'native' | 'credit_alphanum4' | 'credit_alphanum12';
  /** Optional icon URL for the dashboard. */
  icon?: string;
  /** Short description shown in token pickers. */
  description?: string;
  /** True for assets curated by FlowFi. */
  verified: boolean;
  /** Provenance of the metadata. */
  source: TokenMetadataSource;
  /** Trust level derived from `source` and freshness. */
  trustLevel: TokenTrustLevel;
  /** ISO timestamp when the metadata was fetched/derived. */
  fetchedAt: string;
  /** True when the metadata is older than its freshness threshold. */
  stale: boolean;
  /** Machine-readable reason when `stale` is true. */
  staleReason?: TokenStaleReason;
}

/** Machine-readable staleness reasons. */
export type TokenStaleReason =
  | 'exceeded_ttl'
  | 'source_unavailable'
  | 'malformed_source'
  | 'never_fetched';

export interface TokenMetadataList {
  tokens: TokenMetadata[];
  /** ISO timestamp of the last mutation; part of the ETag payload. */
  updatedAt: string;
  /** True when any returned token is stale. */
  stale: boolean;
}

/** Freshness threshold for verified/cached metadata. */
export const TOKEN_METADATA_TTL_MS = 24 * 60 * 60 * 1000;

/** Raw stored record; provenance fields are derived on read. */
interface StoredTokenMetadata extends Omit<
  TokenMetadata,
  'trustLevel' | 'stale' | 'staleReason'
> {
  /** When the underlying source was last successfully read. */
  fetchedAt: string;
}

/** Default verified assets. Contract addresses are env-overridable per network. */
function defaultTokens(): TokenMetadata[] {
  return [
    {
      symbol: 'XLM',
      name: 'Stellar Lumens',
      decimals: 7,
      contractAddress:
        process.env.XLM_TOKEN_ADDRESS ??
        'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN',
      type: 'native',
      icon: 'https://assets.flowfi.xyz/tokens/xlm.svg',
      description: 'Native Stellar token',
      verified: true,
    },
    {
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 7,
      contractAddress:
        process.env.USDC_TOKEN_ADDRESS ??
        'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      type: 'credit_alphanum4',
      icon: 'https://assets.flowfi.xyz/tokens/usdc.svg',
      description: 'USD Coin',
      verified: true,
    },
    {
      symbol: 'EURC',
      name: 'Euro Coin',
      decimals: 7,
      contractAddress:
        process.env.EURC_TOKEN_ADDRESS ??
        'CCWAMYJME4YOIUNAKVYEBYOG5I65QMKEX2NMN4OJAPXRPIF24ONPSHY',
      type: 'credit_alphanum4',
      icon: 'https://assets.flowfi.xyz/tokens/eurc.svg',
      description: 'Euro Coin',
      verified: true,
    },
  ];
}

const verifiedTokens = new Map<string, StoredTokenMetadata>();
let updatedAt = new Date().toISOString();

function nowIso(): string {
  return new Date().toISOString();
}

function isMalformed(token: Partial<TokenMetadata>): boolean {
  if (!token.symbol || typeof token.symbol !== 'string') return true;
  if (!token.name || typeof token.name !== 'string') return true;
  if (typeof token.decimals !== 'number' || !Number.isInteger(token.decimals)) return true;
  if (token.decimals < 0 || token.decimals > 18) return true;
  if (!token.contractAddress || typeof token.contractAddress !== 'string') return true;
  if (
    token.type !== 'native' &&
    token.type !== 'credit_alphanum4' &&
    token.type !== 'credit_alphanum12'
  ) {
    return true;
  }
  return false;
}

function toStored(token: TokenMetadata, source: TokenMetadataSource): StoredTokenMetadata {
  return {
    ...token,
    symbol: token.symbol.toUpperCase(),
    source,
    fetchedAt: token.fetchedAt ?? nowIso(),
  };
}

function loadDefaults(): void {
  verifiedTokens.clear();
  const fetchedAt = nowIso();
  for (const token of defaultTokens()) {
    const source: TokenMetadataSource =
      token.type === 'native' && process.env.XLM_TOKEN_ADDRESS
        ? 'env_override'
        : token.contractAddress !== defaultContractAddress(token.symbol)
          ? 'env_override'
          : 'curated';
    verifiedTokens.set(
      token.symbol.toUpperCase(),
      toStored({ ...token, fetchedAt }, source),
    );
  }
}

/** The built-in contract address for a symbol, ignoring env overrides. */
function defaultContractAddress(symbol: string): string | undefined {
  const env = process.env;
  const saved: Record<string, string | undefined> = {
    XLM_TOKEN_ADDRESS: env.XLM_TOKEN_ADDRESS,
    USDC_TOKEN_ADDRESS: env.USDC_TOKEN_ADDRESS,
    EURC_TOKEN_ADDRESS: env.EURC_TOKEN_ADDRESS,
  };
  try {
    delete env.XLM_TOKEN_ADDRESS;
    delete env.USDC_TOKEN_ADDRESS;
    delete env.EURC_TOKEN_ADDRESS;
    const match = defaultTokens().find(
      (t) => t.symbol.toUpperCase() === symbol.toUpperCase(),
    );
    return match?.contractAddress;
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }
}

/**
 * Derive provenance/freshness fields for a stored record. Raw on-chain amounts
 * are never touched here — only display metadata is annotated.
 */
function decorate(stored: StoredTokenMetadata, now = Date.now()): TokenMetadata {
  const fetchedMs = Date.parse(stored.fetchedAt);
  const age = Number.isFinite(fetchedMs) ? now - fetchedMs : Number.POSITIVE_INFINITY;

  let stale = false;
  let staleReason: TokenStaleReason | undefined;
  let trustLevel: TokenTrustLevel;

  if (!Number.isFinite(fetchedMs)) {
    stale = true;
    staleReason = 'never_fetched';
    trustLevel = 'unknown';
  } else if (stored.source === 'unavailable') {
    stale = true;
    staleReason = 'source_unavailable';
    trustLevel = 'unknown';
  } else if (stored.source === 'default') {
    stale = true;
    staleReason = 'source_unavailable';
    trustLevel = 'fallback';
  } else if (age > TOKEN_METADATA_TTL_MS) {
    stale = true;
    staleReason = 'exceeded_ttl';
    trustLevel = stored.source === 'curated' || stored.source === 'env_override'
      ? 'verified'
      : 'cached';
  } else {
    trustLevel = stored.source === 'curated' || stored.source === 'env_override'
      ? 'verified'
      : 'cached';
  }

  return {
    ...stored,
    trustLevel,
    stale,
    ...(staleReason ? { staleReason } : {}),
  };
}

function touch(): void {
  updatedAt = new Date().toISOString();
}

loadDefaults();

/** All verified tokens, stably ordered by symbol, annotated with provenance. */
export function listVerifiedTokens(): TokenMetadata[] {
  const now = Date.now();
  return [...verifiedTokens.values()]
    .map((stored) => decorate(stored, now))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
}

/** True when any known token's metadata is stale. */
export function hasStaleTokenMetadata(): boolean {
  const now = Date.now();
  for (const stored of verifiedTokens.values()) {
    if (decorate(stored, now).stale) return true;
  }
  return false;
}

/** Version marker used in the payload (and therefore the ETag). */
export function getTokenMetadataUpdatedAt(): string {
  return updatedAt;
}

export function getTokenMetadata(symbol: string): TokenMetadata | undefined {
  const stored = verifiedTokens.get(symbol.toUpperCase());
  return stored ? decorate(stored) : undefined;
}

/**
 * Insert or update a token's metadata. Bumping the version changes the ETag so
 * clients holding a cached copy revalidate on their next request.
 */
export function upsertTokenMetadata(
  token: TokenMetadata | (Omit<TokenMetadata, 'source' | 'fetchedAt'> & Partial<Pick<TokenMetadata, 'source' | 'fetchedAt'>>),
): TokenMetadata {
  const symbol = token.symbol?.toUpperCase();
  if (!symbol || isMalformed({ ...token, symbol })) {
    // Malformed input is rejected rather than stored; callers keep the previous
    // (or fallback) record so raw amounts are never reinterpreted.
    throw new Error('malformed_token_metadata');
  }
  const source: TokenMetadataSource = token.source ?? 'curated';
  const entry = toStored(
    { ...token, symbol, source, fetchedAt: token.fetchedAt ?? nowIso() } as TokenMetadata,
    source,
  );
  verifiedTokens.set(entry.symbol, entry);
  touch();
  return decorate(entry);
}

/**
 * Record that a token's metadata source was unavailable or malformed. The
 * previous record (if any) is retained for display but marked stale so clients
 * can warn instead of silently trusting it.
 */
export function markTokenMetadataUnavailable(
  symbol: string,
  reason: Extract<TokenStaleReason, 'source_unavailable' | 'malformed_source'>,
): TokenMetadata | undefined {
  const key = symbol.toUpperCase();
  const existing = verifiedTokens.get(key);
  if (!existing) return undefined;
  const source: TokenMetadataSource = reason === 'malformed_source' ? 'default' : 'unavailable';
  const entry: StoredTokenMetadata = {
    ...existing,
    source,
    fetchedAt: existing.fetchedAt,
  };
  verifiedTokens.set(key, entry);
  touch();
  const decorated = decorate(entry);
  return {
    ...decorated,
    stale: true,
    staleReason: reason,
    trustLevel: reason === 'malformed_source' ? 'fallback' : 'unknown',
  };
}

/** Remove a token. Also bumps the version so caches are invalidated. */
export function removeTokenMetadata(symbol: string): boolean {
  const removed = verifiedTokens.delete(symbol.toUpperCase());
  if (removed) touch();
  return removed;
}

/** Restore the default seed set. Intended for tests. */
export function resetTokenMetadata(): void {
  loadDefaults();
  touch();
}
