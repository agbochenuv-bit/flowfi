import * as crypto from 'node:crypto';
import * as StellarSdk from '@stellar/stellar-sdk';
import {
  getConfiguredStellarNetwork,
  type StellarNetworkId,
} from '../lib/stellar-network.js';
import { prisma } from '../lib/prisma.js';
import { recordAuditEvent } from './audit.service.js';
import logger from '../logger.js';

/**
 * Wallet-scoped API credentials for integrations (issue #232).
 *
 * Security invariants enforced at this authoritative boundary:
 *  - Secrets are generated with 256 bits of CSPRNG entropy and returned ONLY
 *    once at creation or rotation. Only a per-credential salted SHA-256 digest
 *    is stored; plaintext secrets are never persisted or logged.
 *  - Every credential is bound to a single wallet address and Stellar network.
 *    Cross-wallet lookup, rotation, revocation, and audit access return 404.
 *  - Scopes are validated against a strict, bounded allowlist. API credentials
 *    can NEVER grant platform-admin access or self-manage credentials (those
 *    require a wallet-signed JWT session), and never replace on-chain signing.
 *  - Expiry, rotation overlap grace windows, and immediate revocation are
 *    enforced on every verification call using timing-safe hash comparison.
 */

export const API_CREDENTIAL_SCOPES = [
  'streams:read',
  'streams:write',
  'events:read',
  'webhooks:read',
  'webhooks:write',
  'exports:read',
  'exports:write',
] as const;

export type ApiCredentialScope = (typeof API_CREDENTIAL_SCOPES)[number];

export type ApiCredentialStatus = 'active' | 'rotated' | 'revoked' | 'expired';

export const DEFAULT_CREDENTIAL_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
export const MIN_CREDENTIAL_TTL_SECONDS = 60; // 1 minute
export const MAX_CREDENTIAL_TTL_SECONDS = 365 * 24 * 60 * 60; // 365 days
export const MAX_ROTATION_GRACE_SECONDS = 7 * 24 * 60 * 60; // 7 days
export const MAX_ACTIVE_CREDENTIALS_PER_WALLET = 25;
export const MAX_CREDENTIAL_NAME_LENGTH = 80;

const API_KEY_PREFIX = 'ffk_';
const API_KEY_REGEX = /^ffk_(live|test)_([a-f0-9]{8})_([A-Za-z0-9_-]{32,128})$/;
const VALID_SCOPE_SET = new Set<string>(API_CREDENTIAL_SCOPES);
const MAX_IN_MEMORY_AUDIT_ENTRIES = 2000;

export interface ApiCredentialErrorDetails {
  recoveryHint: string;
  [key: string]: unknown;
}

export class ApiCredentialError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly details: ApiCredentialErrorDetails;

  constructor(
    status: number,
    code: string,
    message: string,
    details: ApiCredentialErrorDetails,
  ) {
    super(message);
    this.name = 'ApiCredentialError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * Internal stored credential record. Contains only salted hash material, never
 * the plaintext secret.
 */
export interface StoredApiCredentialRecord {
  id: string;
  walletAddress: string;
  network: StellarNetworkId;
  name: string;
  keyPrefix: string;
  secretSalt: string;
  secretHash: string;
  scopes: ApiCredentialScope[];
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedReason: string | null;
  rotatedAt: number | null;
  rotatedFromId: string | null;
  rotatedToId: string | null;
  graceExpiresAt: number | null;
}

/**
 * Public, non-secret representation of a wallet-scoped API credential.
 */
export interface ApiCredentialSummary {
  id: string;
  walletAddress: string;
  network: StellarNetworkId;
  name: string;
  keyPrefix: string;
  scopes: ApiCredentialScope[];
  status: ApiCredentialStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  rotatedAt: string | null;
  rotatedFromId: string | null;
  rotatedToId: string | null;
  graceExpiresAt: string | null;
}

export type ApiCredentialAuditAction =
  | 'credential.created'
  | 'credential.rotated'
  | 'credential.revoked'
  | 'credential.auth_succeeded'
  | 'credential.auth_failed';

export interface ApiCredentialAuditEntry {
  id: string;
  action: ApiCredentialAuditAction;
  credentialId: string | null;
  keyPrefix: string | null;
  walletAddress: string | null;
  network: StellarNetworkId;
  outcome: 'success' | 'failure';
  reason: string | null;
  scopes: ApiCredentialScope[];
  requestId: string | null;
  ip: string | null;
  userAgent: string | null;
  timestamp: string;
}

export interface CreateApiCredentialInput {
  walletAddress: string;
  name: unknown;
  scopes: unknown;
  expiresInSeconds?: unknown;
  network?: StellarNetworkId | undefined;
  now?: number | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface CreateApiCredentialResult {
  credential: ApiCredentialSummary;
  /** Shown once at creation; never stored or returned again. */
  secret: string;
  warning: string;
}

export interface RotateApiCredentialInput {
  walletAddress: string;
  credentialId: string;
  gracePeriodSeconds?: unknown;
  expiresInSeconds?: unknown;
  scopes?: unknown;
  name?: unknown;
  now?: number | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface RotateApiCredentialResult {
  credential: ApiCredentialSummary;
  previousCredential: ApiCredentialSummary;
  /** Shown once at rotation; never stored or returned again. */
  secret: string;
  warning: string;
}

export interface RevokeApiCredentialInput {
  walletAddress: string;
  credentialId: string;
  reason?: string | undefined;
  now?: number | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface RevokeApiCredentialResult {
  credential: ApiCredentialSummary;
  revoked: boolean;
  alreadyRevoked: boolean;
}

export interface VerifiedApiCredential {
  credentialId: string;
  keyPrefix: string;
  walletAddress: string;
  network: StellarNetworkId;
  scopes: ApiCredentialScope[];
  status: 'active' | 'rotated';
  expiresAt: string;
  graceExpiresAt: string | null;
}

export type VerifyApiCredentialResult =
  | {
      ok: true;
      credential: VerifiedApiCredential;
    }
  | {
      ok: false;
      status: 401 | 403;
      code:
        | 'CREDENTIAL_INVALID'
        | 'CREDENTIAL_REVOKED'
        | 'CREDENTIAL_EXPIRED'
        | 'CREDENTIAL_ROTATED_EXPIRED'
        | 'CREDENTIAL_NETWORK_MISMATCH'
        | 'INSUFFICIENT_SCOPE';
      message: string;
      recoveryHint: string;
      details?: Record<string, unknown> | undefined;
    };

export interface VerifyApiCredentialOptions {
  requiredScopes?: readonly ApiCredentialScope[] | undefined;
  expectedNetwork?: StellarNetworkId | undefined;
  now?: number | undefined;
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface ApiCredentialStore {
  save(record: StoredApiCredentialRecord): void;
  findById(id: string): StoredApiCredentialRecord | undefined;
  findByKeyPrefix(keyPrefix: string): StoredApiCredentialRecord | undefined;
  listByWallet(walletAddress: string): StoredApiCredentialRecord[];
  clear(): void;
}

class InMemoryApiCredentialStore implements ApiCredentialStore {
  private readonly byId = new Map<string, StoredApiCredentialRecord>();
  private readonly idByPrefix = new Map<string, string>();

  save(record: StoredApiCredentialRecord): void {
    const copy: StoredApiCredentialRecord = {
      ...record,
      scopes: [...record.scopes],
    };
    this.byId.set(copy.id, copy);
    this.idByPrefix.set(copy.keyPrefix, copy.id);
  }

  findById(id: string): StoredApiCredentialRecord | undefined {
    const found = this.byId.get(id);
    return found ? { ...found, scopes: [...found.scopes] } : undefined;
  }

  findByKeyPrefix(keyPrefix: string): StoredApiCredentialRecord | undefined {
    const id = this.idByPrefix.get(keyPrefix);
    if (!id) return undefined;
    return this.findById(id);
  }

  listByWallet(walletAddress: string): StoredApiCredentialRecord[] {
    const results: StoredApiCredentialRecord[] = [];
    for (const record of this.byId.values()) {
      if (record.walletAddress === walletAddress) {
        results.push({ ...record, scopes: [...record.scopes] });
      }
    }
    return results.sort((a, b) => b.createdAt - a.createdAt);
  }

  clear(): void {
    this.byId.clear();
    this.idByPrefix.clear();
  }
}

let credentialStore: ApiCredentialStore = new InMemoryApiCredentialStore();
const auditTrail: ApiCredentialAuditEntry[] = [];

export function isApiCredentialToken(raw: string | null | undefined): boolean {
  return typeof raw === 'string' && raw.startsWith(API_KEY_PREFIX);
}

function hashSecret(salt: string, rawSecret: string): string {
  return crypto
    .createHash('sha256')
    .update(`${salt}:${rawSecret}`)
    .digest('hex');
}

function verifySecretHash(
  salt: string,
  rawSecret: string,
  expectedHash: string,
): boolean {
  const actual = Buffer.from(hashSecret(salt, rawSecret), 'utf8');
  const expected = Buffer.from(expectedHash, 'utf8');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function generateSecret(network: StellarNetworkId): {
  keyPrefix: string;
  secret: string;
} {
  const networkTag = network === 'mainnet' ? 'live' : 'test';
  const publicId = crypto.randomBytes(4).toString('hex');
  const secretBody = crypto.randomBytes(32).toString('base64url');
  const keyPrefix = `${API_KEY_PREFIX}${networkTag}_${publicId}`;
  return {
    keyPrefix,
    secret: `${keyPrefix}_${secretBody}`,
  };
}

function computeStatus(
  record: StoredApiCredentialRecord,
  now: number,
): ApiCredentialStatus {
  if (record.revokedAt !== null) return 'revoked';
  if (record.rotatedAt !== null) {
    if (record.graceExpiresAt !== null && now < record.graceExpiresAt && now < record.expiresAt) {
      return 'rotated';
    }
    return 'expired';
  }
  if (now >= record.expiresAt) return 'expired';
  return 'active';
}

function toCredentialSummary(
  record: StoredApiCredentialRecord,
  now: number,
): ApiCredentialSummary {
  return {
    id: record.id,
    walletAddress: record.walletAddress,
    network: record.network,
    name: record.name,
    keyPrefix: record.keyPrefix,
    scopes: [...record.scopes],
    status: computeStatus(record, now),
    createdAt: new Date(record.createdAt).toISOString(),
    expiresAt: new Date(record.expiresAt).toISOString(),
    lastUsedAt:
      record.lastUsedAt !== null
        ? new Date(record.lastUsedAt).toISOString()
        : null,
    revokedAt:
      record.revokedAt !== null
        ? new Date(record.revokedAt).toISOString()
        : null,
    revokedReason: record.revokedReason,
    rotatedAt:
      record.rotatedAt !== null
        ? new Date(record.rotatedAt).toISOString()
        : null,
    rotatedFromId: record.rotatedFromId,
    rotatedToId: record.rotatedToId,
    graceExpiresAt:
      record.graceExpiresAt !== null
        ? new Date(record.graceExpiresAt).toISOString()
        : null,
  };
}

function validateWalletAddress(walletAddress: string): void {
  if (
    !walletAddress ||
    typeof walletAddress !== 'string' ||
    !StellarSdk.StrKey.isValidEd25519PublicKey(walletAddress)
  ) {
    throw new ApiCredentialError(
      400,
      'INVALID_WALLET_ADDRESS',
      'A valid Stellar Ed25519 wallet address is required',
      {
        field: 'walletAddress',
        recoveryHint: 'Authenticate with a valid Stellar wallet before managing API credentials.',
      },
    );
  }
}

function validateCredentialName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new ApiCredentialError(
      400,
      'INVALID_CREDENTIAL_NAME',
      'Credential name must be a non-empty string',
      {
        field: 'name',
        maxLength: MAX_CREDENTIAL_NAME_LENGTH,
        recoveryHint: `Provide a name between 1 and ${MAX_CREDENTIAL_NAME_LENGTH} characters.`,
      },
    );
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_CREDENTIAL_NAME_LENGTH) {
    throw new ApiCredentialError(
      400,
      'INVALID_CREDENTIAL_NAME',
      `Credential name must be between 1 and ${MAX_CREDENTIAL_NAME_LENGTH} characters`,
      {
        field: 'name',
        maxLength: MAX_CREDENTIAL_NAME_LENGTH,
        recoveryHint: `Provide a name between 1 and ${MAX_CREDENTIAL_NAME_LENGTH} characters.`,
      },
    );
  }
  return trimmed;
}

function validateScopes(raw: unknown): ApiCredentialScope[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ApiCredentialError(
      400,
      'INVALID_SCOPES',
      `scopes must be a non-empty array chosen from: ${API_CREDENTIAL_SCOPES.join(', ')}`,
      {
        field: 'scopes',
        allowedScopes: API_CREDENTIAL_SCOPES,
        recoveryHint: `Specify at least one valid scope from: ${API_CREDENTIAL_SCOPES.join(', ')}.`,
      },
    );
  }

  const normalized: string[] = [];
  const invalid: unknown[] = [];

  for (const item of raw) {
    if (typeof item !== 'string') {
      invalid.push(item);
      continue;
    }
    const candidate = item.trim().toLowerCase();
    if (!VALID_SCOPE_SET.has(candidate)) {
      invalid.push(item);
      continue;
    }
    normalized.push(candidate);
  }

  if (invalid.length > 0 || normalized.length === 0) {
    throw new ApiCredentialError(
      400,
      'INVALID_SCOPES',
      `Unsupported scope(s) requested. Allowed scopes: ${API_CREDENTIAL_SCOPES.join(', ')}`,
      {
        field: 'scopes',
        invalidScopes: invalid,
        allowedScopes: API_CREDENTIAL_SCOPES,
        recoveryHint: `Remove invalid scopes and use only: ${API_CREDENTIAL_SCOPES.join(', ')}.`,
      },
    );
  }

  const unique = Array.from(new Set(normalized)) as ApiCredentialScope[];
  unique.sort(
    (a, b) =>
      API_CREDENTIAL_SCOPES.indexOf(a) - API_CREDENTIAL_SCOPES.indexOf(b),
  );
  return unique;
}

function validateTtlSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return DEFAULT_CREDENTIAL_TTL_SECONDS;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new ApiCredentialError(
      400,
      'INVALID_EXPIRY',
      `expiresInSeconds must be an integer between ${MIN_CREDENTIAL_TTL_SECONDS} and ${MAX_CREDENTIAL_TTL_SECONDS}`,
      {
        field: 'expiresInSeconds',
        minSeconds: MIN_CREDENTIAL_TTL_SECONDS,
        maxSeconds: MAX_CREDENTIAL_TTL_SECONDS,
        recoveryHint: `Set expiresInSeconds between ${MIN_CREDENTIAL_TTL_SECONDS} and ${MAX_CREDENTIAL_TTL_SECONDS}.`,
      },
    );
  }
  if (raw < MIN_CREDENTIAL_TTL_SECONDS || raw > MAX_CREDENTIAL_TTL_SECONDS) {
    throw new ApiCredentialError(
      400,
      'INVALID_EXPIRY',
      `expiresInSeconds must be between ${MIN_CREDENTIAL_TTL_SECONDS} and ${MAX_CREDENTIAL_TTL_SECONDS}`,
      {
        field: 'expiresInSeconds',
        minSeconds: MIN_CREDENTIAL_TTL_SECONDS,
        maxSeconds: MAX_CREDENTIAL_TTL_SECONDS,
        recoveryHint: `Choose a TTL between ${MIN_CREDENTIAL_TTL_SECONDS}s (1 min) and ${MAX_CREDENTIAL_TTL_SECONDS}s (365 days).`,
      },
    );
  }
  return raw;
}

function validateGracePeriodSeconds(raw: unknown): number {
  if (raw === undefined || raw === null) {
    return 0;
  }
  if (
    typeof raw !== 'number' ||
    !Number.isInteger(raw) ||
    raw < 0 ||
    raw > MAX_ROTATION_GRACE_SECONDS
  ) {
    throw new ApiCredentialError(
      400,
      'INVALID_GRACE_PERIOD',
      `gracePeriodSeconds must be an integer between 0 and ${MAX_ROTATION_GRACE_SECONDS}`,
      {
        field: 'gracePeriodSeconds',
        minSeconds: 0,
        maxSeconds: MAX_ROTATION_GRACE_SECONDS,
        recoveryHint: `Set gracePeriodSeconds between 0 (immediate revocation) and ${MAX_ROTATION_GRACE_SECONDS} (7 days).`,
      },
    );
  }
  return raw;
}

function appendAuditEntry(entry: Omit<ApiCredentialAuditEntry, 'id'>): void {
  const fullEntry: ApiCredentialAuditEntry = {
    id: crypto.randomUUID(),
    ...entry,
  };
  auditTrail.push(fullEntry);
  if (auditTrail.length > MAX_IN_MEMORY_AUDIT_ENTRIES) {
    auditTrail.splice(0, auditTrail.length - MAX_IN_MEMORY_AUDIT_ENTRIES);
  }

  // Best-effort durable audit emission when Prisma auditEvent model is available.
  const prismaLike = prisma as unknown as {
    auditEvent?: { create?: unknown };
  };
  if (typeof prismaLike.auditEvent?.create === 'function') {
    void recordAuditEvent({
      actor: fullEntry.walletAddress ?? 'anonymous',
      action: fullEntry.action,
      targetType: 'api_credential',
      targetId: fullEntry.credentialId ?? fullEntry.keyPrefix ?? 'unknown',
      outcome: fullEntry.outcome,
      ...(fullEntry.requestId ? { requestId: fullEntry.requestId } : {}),
      metadata: {
        keyPrefix: fullEntry.keyPrefix,
        network: fullEntry.network,
        reason: fullEntry.reason,
        scopes: fullEntry.scopes,
        ip: fullEntry.ip,
      },
    }).catch((err: unknown) => {
      logger.warn('[ApiCredentialService] Durable audit write failed:', err);
    });
  }
}

/**
 * Create a new wallet-scoped API credential.
 * Returns the plaintext secret ONCE; callers must persist it immediately.
 */
export function createApiCredential(
  input: CreateApiCredentialInput,
): CreateApiCredentialResult {
  const now = input.now ?? Date.now();
  const network = input.network ?? getConfiguredStellarNetwork();

  validateWalletAddress(input.walletAddress);
  const name = validateCredentialName(input.name);
  const scopes = validateScopes(input.scopes);
  const ttlSeconds = validateTtlSeconds(input.expiresInSeconds);

  const existing = credentialStore.listByWallet(input.walletAddress);
  const usableCount = existing.filter((record) => {
    const status = computeStatus(record, now);
    return status === 'active' || status === 'rotated';
  }).length;

  if (usableCount >= MAX_ACTIVE_CREDENTIALS_PER_WALLET) {
    throw new ApiCredentialError(
      409,
      'CREDENTIAL_LIMIT_EXCEEDED',
      `Wallet has reached the maximum of ${MAX_ACTIVE_CREDENTIALS_PER_WALLET} active API credentials`,
      {
        maxActiveCredentials: MAX_ACTIVE_CREDENTIALS_PER_WALLET,
        activeCount: usableCount,
        recoveryHint:
          'Revoke unused or expired credentials before creating a new one.',
      },
    );
  }

  const { keyPrefix, secret } = generateSecret(network);
  const secretSalt = crypto.randomBytes(32).toString('hex');
  const secretHash = hashSecret(secretSalt, secret);

  const record: StoredApiCredentialRecord = {
    id: crypto.randomUUID(),
    walletAddress: input.walletAddress,
    network,
    name,
    keyPrefix,
    secretSalt,
    secretHash,
    scopes,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    rotatedAt: null,
    rotatedFromId: null,
    rotatedToId: null,
    graceExpiresAt: null,
  };

  credentialStore.save(record);

  appendAuditEntry({
    action: 'credential.created',
    credentialId: record.id,
    keyPrefix: record.keyPrefix,
    walletAddress: record.walletAddress,
    network: record.network,
    outcome: 'success',
    reason: null,
    scopes: record.scopes,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    timestamp: new Date(now).toISOString(),
  });

  return {
    credential: toCredentialSummary(record, now),
    secret,
    warning: 'Store this secret now. It will not be shown again.',
  };
}

/**
 * List all credentials belonging to the authenticated wallet (metadata only).
 */
export function listApiCredentials(
  walletAddress: string,
  options: { includeInactive?: boolean | undefined; now?: number | undefined } = {},
): ApiCredentialSummary[] {
  const now = options.now ?? Date.now();
  const includeInactive = options.includeInactive ?? true;
  const records = credentialStore.listByWallet(walletAddress);
  const summaries = records.map((r) => toCredentialSummary(r, now));
  if (includeInactive) {
    return summaries;
  }
  return summaries.filter(
    (s) => s.status === 'active' || s.status === 'rotated',
  );
}

/**
 * Fetch metadata for a single credential owned by `walletAddress`.
 * Returns `null` if unknown OR owned by a different wallet (cross-wallet isolation).
 */
export function getApiCredential(
  walletAddress: string,
  credentialId: string,
  options: { now?: number | undefined } = {},
): ApiCredentialSummary | null {
  const now = options.now ?? Date.now();
  const record = credentialStore.findById(credentialId);
  if (!record || record.walletAddress !== walletAddress) {
    return null;
  }
  return toCredentialSummary(record, now);
}

/**
 * Rotate an active credential owned by `walletAddress`.
 * Supports immediate cutover (`gracePeriodSeconds = 0`) or a bounded overlap
 * grace window (`gracePeriodSeconds > 0`) for zero-downtime secret rollout.
 */
export function rotateApiCredential(
  input: RotateApiCredentialInput,
): RotateApiCredentialResult {
  const now = input.now ?? Date.now();
  const existing = credentialStore.findById(input.credentialId);

  if (!existing || existing.walletAddress !== input.walletAddress) {
    throw new ApiCredentialError(
      404,
      'CREDENTIAL_NOT_FOUND',
      'API credential not found',
      {
        recoveryHint:
          'Verify the credential ID and ensure you are authenticated with the owning wallet.',
      },
    );
  }

  const currentStatus = computeStatus(existing, now);
  if (currentStatus !== 'active') {
    throw new ApiCredentialError(
      409,
      'CREDENTIAL_NOT_ROTATABLE',
      `Cannot rotate a credential in "${currentStatus}" state`,
      {
        credentialId: existing.id,
        status: currentStatus,
        recoveryHint:
          'Create a new API credential instead of rotating a revoked, expired, or already rotated credential.',
      },
    );
  }

  const gracePeriodSeconds = validateGracePeriodSeconds(
    input.gracePeriodSeconds,
  );
  const newName =
    input.name !== undefined
      ? validateCredentialName(input.name)
      : existing.name;
  const newScopes =
    input.scopes !== undefined
      ? validateScopes(input.scopes)
      : [...existing.scopes];
  const newTtlSeconds =
    input.expiresInSeconds !== undefined
      ? validateTtlSeconds(input.expiresInSeconds)
      : Math.max(
          MIN_CREDENTIAL_TTL_SECONDS,
          Math.min(
            MAX_CREDENTIAL_TTL_SECONDS,
            Math.round((existing.expiresAt - existing.createdAt) / 1000),
          ),
        );

  const { keyPrefix, secret } = generateSecret(existing.network);
  const secretSalt = crypto.randomBytes(32).toString('hex');
  const secretHash = hashSecret(secretSalt, secret);

  const replacement: StoredApiCredentialRecord = {
    id: crypto.randomUUID(),
    walletAddress: existing.walletAddress,
    network: existing.network,
    name: newName,
    keyPrefix,
    secretSalt,
    secretHash,
    scopes: newScopes,
    createdAt: now,
    expiresAt: now + newTtlSeconds * 1000,
    lastUsedAt: null,
    revokedAt: null,
    revokedReason: null,
    rotatedAt: null,
    rotatedFromId: existing.id,
    rotatedToId: null,
    graceExpiresAt: null,
  };

  const updatedPrevious: StoredApiCredentialRecord = {
    ...existing,
    rotatedAt: now,
    rotatedToId: replacement.id,
    ...(gracePeriodSeconds === 0
      ? {
          revokedAt: now,
          revokedReason: 'rotated',
          graceExpiresAt: null,
        }
      : {
          graceExpiresAt: Math.min(
            existing.expiresAt,
            now + gracePeriodSeconds * 1000,
          ),
        }),
  };

  credentialStore.save(replacement);
  credentialStore.save(updatedPrevious);

  appendAuditEntry({
    action: 'credential.rotated',
    credentialId: replacement.id,
    keyPrefix: replacement.keyPrefix,
    walletAddress: replacement.walletAddress,
    network: replacement.network,
    outcome: 'success',
    reason:
      gracePeriodSeconds > 0
        ? `rotated_with_grace_${gracePeriodSeconds}s`
        : 'rotated_immediate',
    scopes: replacement.scopes,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    timestamp: new Date(now).toISOString(),
  });

  return {
    credential: toCredentialSummary(replacement, now),
    previousCredential: toCredentialSummary(updatedPrevious, now),
    secret,
    warning: 'Store this secret now. It will not be shown again.',
  };
}

/**
 * Immediately revoke a credential owned by `walletAddress`.
 * Idempotent for already-revoked credentials belonging to the same wallet.
 */
export function revokeApiCredential(
  input: RevokeApiCredentialInput,
): RevokeApiCredentialResult {
  const now = input.now ?? Date.now();
  const existing = credentialStore.findById(input.credentialId);

  if (!existing || existing.walletAddress !== input.walletAddress) {
    throw new ApiCredentialError(
      404,
      'CREDENTIAL_NOT_FOUND',
      'API credential not found',
      {
        recoveryHint:
          'Verify the credential ID and ensure you are authenticated with the owning wallet.',
      },
    );
  }

  if (existing.revokedAt !== null) {
    return {
      credential: toCredentialSummary(existing, now),
      revoked: true,
      alreadyRevoked: true,
    };
  }

  const updated: StoredApiCredentialRecord = {
    ...existing,
    revokedAt: now,
    revokedReason: input.reason?.trim() || 'manual_revocation',
    graceExpiresAt: null,
  };
  credentialStore.save(updated);

  appendAuditEntry({
    action: 'credential.revoked',
    credentialId: updated.id,
    keyPrefix: updated.keyPrefix,
    walletAddress: updated.walletAddress,
    network: updated.network,
    outcome: 'success',
    reason: updated.revokedReason,
    scopes: updated.scopes,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    timestamp: new Date(now).toISOString(),
  });

  return {
    credential: toCredentialSummary(updated, now),
    revoked: true,
    alreadyRevoked: false,
  };
}

/**
 * Authoritatively verify a presented API credential secret, checking format,
 * salted digest (timing-safe), network binding, revocation, expiry/grace
 * window, and optional required scopes.
 */
export function verifyApiCredential(
  rawSecret: string,
  options: VerifyApiCredentialOptions = {},
): VerifyApiCredentialResult {
  const now = options.now ?? Date.now();
  const expectedNetwork =
    options.expectedNetwork ?? getConfiguredStellarNetwork();

  const match = API_KEY_REGEX.exec(rawSecret);
  if (!match) {
    appendAuditEntry({
      action: 'credential.auth_failed',
      credentialId: null,
      keyPrefix: null,
      walletAddress: null,
      network: expectedNetwork,
      outcome: 'failure',
      reason: 'invalid_format',
      scopes: [],
      requestId: options.requestId ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      timestamp: new Date(now).toISOString(),
    });
    return {
      ok: false,
      status: 401,
      code: 'CREDENTIAL_INVALID',
      message: 'Malformed or invalid API credential',
      recoveryHint:
        'Provide a valid API credential issued via POST /v1/credentials.',
    };
  }

  const networkTag = match[1]!;
  const publicId = match[2]!;
  const keyPrefix = `${API_KEY_PREFIX}${networkTag}_${publicId}`;
  const record = credentialStore.findByKeyPrefix(keyPrefix);

  if (
    !record ||
    !verifySecretHash(record.secretSalt, rawSecret, record.secretHash)
  ) {
    appendAuditEntry({
      action: 'credential.auth_failed',
      credentialId: record?.id ?? null,
      keyPrefix,
      walletAddress: record?.walletAddress ?? null,
      network: expectedNetwork,
      outcome: 'failure',
      reason: record ? 'invalid_secret' : 'not_found',
      scopes: [],
      requestId: options.requestId ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      timestamp: new Date(now).toISOString(),
    });
    return {
      ok: false,
      status: 401,
      code: 'CREDENTIAL_INVALID',
      message: 'Invalid API credential',
      recoveryHint:
        'Check that the full secret was copied accurately or issue a new credential.',
    };
  }

  if (record.network !== expectedNetwork) {
    appendAuditEntry({
      action: 'credential.auth_failed',
      credentialId: record.id,
      keyPrefix: record.keyPrefix,
      walletAddress: record.walletAddress,
      network: expectedNetwork,
      outcome: 'failure',
      reason: 'network_mismatch',
      scopes: record.scopes,
      requestId: options.requestId ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      timestamp: new Date(now).toISOString(),
    });
    return {
      ok: false,
      status: 401,
      code: 'CREDENTIAL_NETWORK_MISMATCH',
      message: `API credential is scoped to ${record.network} and cannot be used on ${expectedNetwork}`,
      recoveryHint: `Create an API credential on ${expectedNetwork} or send requests to the ${record.network} API.`,
      details: {
        credentialNetwork: record.network,
        expectedNetwork,
      },
    };
  }

  if (record.revokedAt !== null) {
    appendAuditEntry({
      action: 'credential.auth_failed',
      credentialId: record.id,
      keyPrefix: record.keyPrefix,
      walletAddress: record.walletAddress,
      network: record.network,
      outcome: 'failure',
      reason: 'revoked',
      scopes: record.scopes,
      requestId: options.requestId ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      timestamp: new Date(now).toISOString(),
    });
    return {
      ok: false,
      status: 401,
      code: 'CREDENTIAL_REVOKED',
      message: 'API credential has been revoked',
      recoveryHint:
        'Switch to the rotated replacement credential or create a new credential via POST /v1/credentials.',
    };
  }

  if (record.rotatedAt !== null) {
    if (record.graceExpiresAt === null || now >= record.graceExpiresAt) {
      appendAuditEntry({
        action: 'credential.auth_failed',
        credentialId: record.id,
        keyPrefix: record.keyPrefix,
        walletAddress: record.walletAddress,
        network: record.network,
        outcome: 'failure',
        reason: 'rotated_grace_expired',
        scopes: record.scopes,
        requestId: options.requestId ?? null,
        ip: options.ip ?? null,
        userAgent: options.userAgent ?? null,
        timestamp: new Date(now).toISOString(),
      });
      return {
        ok: false,
        status: 401,
        code: 'CREDENTIAL_ROTATED_EXPIRED',
        message: 'API credential rotation grace window has expired',
        recoveryHint:
          'Deploy the replacement secret returned by POST /v1/credentials/:id/rotate.',
      };
    }
  }

  if (now >= record.expiresAt) {
    appendAuditEntry({
      action: 'credential.auth_failed',
      credentialId: record.id,
      keyPrefix: record.keyPrefix,
      walletAddress: record.walletAddress,
      network: record.network,
      outcome: 'failure',
      reason: 'expired',
      scopes: record.scopes,
      requestId: options.requestId ?? null,
      ip: options.ip ?? null,
      userAgent: options.userAgent ?? null,
      timestamp: new Date(now).toISOString(),
    });
    return {
      ok: false,
      status: 401,
      code: 'CREDENTIAL_EXPIRED',
      message: 'API credential has expired',
      recoveryHint:
        'Create a new API credential via POST /v1/credentials.',
    };
  }

  const requiredScopes = options.requiredScopes ?? [];
  if (requiredScopes.length > 0) {
    const missingScopes = requiredScopes.filter(
      (scope) => !record.scopes.includes(scope),
    );
    if (missingScopes.length > 0) {
      appendAuditEntry({
        action: 'credential.auth_failed',
        credentialId: record.id,
        keyPrefix: record.keyPrefix,
        walletAddress: record.walletAddress,
        network: record.network,
        outcome: 'failure',
        reason: `insufficient_scope:${missingScopes.join(',')}`,
        scopes: record.scopes,
        requestId: options.requestId ?? null,
        ip: options.ip ?? null,
        userAgent: options.userAgent ?? null,
        timestamp: new Date(now).toISOString(),
      });
      return {
        ok: false,
        status: 403,
        code: 'INSUFFICIENT_SCOPE',
        message: `API credential lacks required scope(s): ${missingScopes.join(', ')}`,
        recoveryHint: `Create or rotate a credential with scope(s): ${missingScopes.join(', ')}.`,
        details: {
          requiredScopes: [...requiredScopes],
          missingScopes,
          grantedScopes: [...record.scopes],
        },
      };
    }
  }

  const updated: StoredApiCredentialRecord = {
    ...record,
    lastUsedAt: now,
  };
  credentialStore.save(updated);

  appendAuditEntry({
    action: 'credential.auth_succeeded',
    credentialId: updated.id,
    keyPrefix: updated.keyPrefix,
    walletAddress: updated.walletAddress,
    network: updated.network,
    outcome: 'success',
    reason: null,
    scopes: updated.scopes,
    requestId: options.requestId ?? null,
    ip: options.ip ?? null,
    userAgent: options.userAgent ?? null,
    timestamp: new Date(now).toISOString(),
  });

  const status = updated.rotatedAt !== null ? 'rotated' : 'active';
  return {
    ok: true,
    credential: {
      credentialId: updated.id,
      keyPrefix: updated.keyPrefix,
      walletAddress: updated.walletAddress,
      network: updated.network,
      scopes: [...updated.scopes],
      status,
      expiresAt: new Date(updated.expiresAt).toISOString(),
      graceExpiresAt:
        updated.graceExpiresAt !== null
          ? new Date(updated.graceExpiresAt).toISOString()
          : null,
    },
  };
}

/**
 * Record an authorization scope denial for an already-authenticated API
 * credential (used by route-level `requireScope` middleware).
 */
export function recordCredentialScopeDenial(input: {
  credentialId: string;
  keyPrefix?: string | null | undefined;
  walletAddress: string;
  grantedScopes: ApiCredentialScope[];
  requiredScopes: readonly ApiCredentialScope[];
  requestId?: string | undefined;
  ip?: string | undefined;
  userAgent?: string | undefined;
  now?: number | undefined;
}): void {
  const now = input.now ?? Date.now();
  const missing = input.requiredScopes.filter(
    (s) => !input.grantedScopes.includes(s),
  );
  appendAuditEntry({
    action: 'credential.auth_failed',
    credentialId: input.credentialId,
    keyPrefix: input.keyPrefix ?? null,
    walletAddress: input.walletAddress,
    network: getConfiguredStellarNetwork(),
    outcome: 'failure',
    reason: `insufficient_scope:${missing.join(',')}`,
    scopes: [...input.grantedScopes],
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
    timestamp: new Date(now).toISOString(),
  });
}

/**
 * List audit entries for credentials owned by `walletAddress`.
 * Cross-wallet isolation: requesting audit events for a `credentialId` owned
 * by another wallet throws 404 `CREDENTIAL_NOT_FOUND`.
 */
export function listCredentialAuditEvents(
  walletAddress: string,
  options: { credentialId?: string | undefined; limit?: number | undefined } = {},
): ApiCredentialAuditEntry[] {
  if (options.credentialId !== undefined) {
    const record = credentialStore.findById(options.credentialId);
    if (!record || record.walletAddress !== walletAddress) {
      throw new ApiCredentialError(
        404,
        'CREDENTIAL_NOT_FOUND',
        'API credential not found',
        {
          recoveryHint:
            'Verify the credential ID and ensure you are authenticated with the owning wallet.',
        },
      );
    }
  }

  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const matching = auditTrail.filter((entry) => {
    if (entry.walletAddress !== walletAddress) return false;
    if (
      options.credentialId !== undefined &&
      entry.credentialId !== options.credentialId
    ) {
      return false;
    }
    return true;
  });

  return matching
    .slice(-limit)
    .reverse()
    .map((entry) => ({ ...entry, scopes: [...entry.scopes] }));
}

export const __apiCredentialTestUtils = {
  clearAll(): void {
    credentialStore.clear();
    auditTrail.length = 0;
  },
  getRawRecord(id: string): StoredApiCredentialRecord | undefined {
    return credentialStore.findById(id);
  },
  setStore(store: ApiCredentialStore): void {
    credentialStore = store;
  },
  resetStore(): void {
    credentialStore = new InMemoryApiCredentialStore();
    auditTrail.length = 0;
  },
  getAllAuditEvents(): ApiCredentialAuditEntry[] {
    return auditTrail.map((entry) => ({ ...entry, scopes: [...entry.scopes] }));
  },
};
