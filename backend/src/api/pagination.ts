import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed, query-bound pagination cursors.
 *
 * A cursor encodes the position of the last item on a page together with the
 * query context (filters, sort order, network) it was issued for. The payload
 * is authenticated with an HMAC so clients cannot tamper with it or reuse a
 * cursor against a different query.
 *
 * Cursor lifetime: cursors expire `DEFAULT_TTL_MS` after issuance. Expired
 * cursors are rejected with `CURSOR_EXPIRED`; clients should restart from the
 * first page.
 */

export const DEFAULT_TTL_MS = 15 * 60 * 1000;

export type CursorErrorCode =
  | 'CURSOR_INVALID'
  | 'CURSOR_TAMPERED'
  | 'CURSOR_EXPIRED'
  | 'CURSOR_MISMATCH';

export class CursorError extends Error {
  readonly code: CursorErrorCode;

  constructor(code: CursorErrorCode, message: string) {
    super(message);
    this.name = 'CursorError';
    this.code = code;
  }
}

export interface CursorContext {
  /** Stable, canonical representation of the active filters. */
  filters: Record<string, unknown>;
  /** Sort key(s) the page was ordered by, e.g. `createdAt:desc`. */
  sort: string;
  /** Chain/network the query was scoped to. */
  network: string;
}

export interface CursorPayload {
  /** Opaque position of the last item on the page. */
  position: string;
  /** Issued-at timestamp (ms since epoch). */
  iat: number;
  /** Expiry timestamp (ms since epoch). */
  exp: number;
  /** Query context the cursor is bound to. */
  ctx: CursorContext;
}

interface SignedCursor {
  p: CursorPayload;
  s: string;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

function contextFingerprint(ctx: CursorContext): string {
  return canonicalize({ filters: ctx.filters, sort: ctx.sort, network: ctx.network });
}

function sign(secret: string, payload: CursorPayload): string {
  return createHmac('sha256', secret)
    .update(canonicalize(payload))
    .digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function encode(signed: SignedCursor): string {
  return Buffer.from(JSON.stringify(signed), 'utf8').toString('base64url');
}

function decode(cursor: string): SignedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new CursorError('CURSOR_INVALID', 'Malformed pagination cursor');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as SignedCursor).s !== 'string' ||
    !(parsed as SignedCursor).p ||
    typeof (parsed as SignedCursor).p !== 'object'
  ) {
    throw new CursorError('CURSOR_INVALID', 'Malformed pagination cursor');
  }
  return parsed as SignedCursor;
}

export interface EncodeCursorOptions {
  secret: string;
  position: string;
  context: CursorContext;
  ttlMs?: number;
  now?: number;
}

export function encodeCursor(options: EncodeCursorOptions): string {
  const { secret, position, context } = options;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const payload: CursorPayload = {
    position,
    iat: now,
    exp: now + ttlMs,
    ctx: {
      filters: context.filters,
      sort: context.sort,
      network: context.network,
    },
  };
  return encode({ p: payload, s: sign(secret, payload) });
}

export interface DecodeCursorOptions {
  secret: string;
  context: CursorContext;
  now?: number;
}

export function decodeCursor(cursor: string, options: DecodeCursorOptions): CursorPayload {
  const { secret, context } = options;
  const now = options.now ?? Date.now();
  const signed = decode(cursor);

  const expected = sign(secret, signed.p);
  if (!safeEqual(expected, signed.s)) {
    throw new CursorError('CURSOR_TAMPERED', 'Pagination cursor failed integrity check');
  }

  if (typeof signed.p.exp !== 'number' || now > signed.p.exp) {
    throw new CursorError('CURSOR_EXPIRED', 'Pagination cursor has expired');
  }

  if (contextFingerprint(signed.p.ctx) !== contextFingerprint(context)) {
    throw new CursorError(
      'CURSOR_MISMATCH',
      'Pagination cursor does not match the current query',
    );
  }

  return signed.p;
}
