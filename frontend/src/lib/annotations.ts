/**
 * Local transaction annotations store.
 *
 * PRIVACY & STORAGE BOUNDARIES
 * ----------------------------
 * Annotations are operational context that users attach to a transaction
 * (e.g. "rent payment", "invoice #42"). They are:
 *
 *   - Stored ONLY in the browser's `localStorage`, under a namespaced key.
 *   - NEVER published on-chain, never sent to any backend, and never included
 *     in any network request made by this module.
 *   - Keyed by wallet address AND transaction hash, so annotations are
 *     isolated per wallet. Switching wallets in the UI must not surface another
 *     wallet's annotations (see `listAnnotations` / `exportAnnotations`).
 *   - Optionally encrypted at rest with a user-supplied passphrase using
 *     WebCrypto AES-GCM. When encryption is enabled, the plaintext never
 *     touches `localStorage`; only ciphertext + salt + IV are persisted.
 *     The passphrase is held only in memory for the duration of a call and is
 *     never persisted.
 *
 * Export behavior: `exportAnnotations` includes annotations for the currently
 * selected wallet only, and returns plaintext (decrypting when necessary) so
 * the caller can hand the result to a user-initiated download. Export never
 * mutates stored state.
 *
 * This module intentionally has no network dependencies and no side effects
 * beyond reading/writing `localStorage`.
 */

export interface Annotation {
  /** Wallet address (normalized) this annotation belongs to. */
  wallet: string;
  /** Transaction hash this annotation belongs to. */
  txHash: string;
  /** Free-form annotation text (plaintext in memory). */
  note: string;
  /** Creation timestamp (ms since epoch). */
  createdAt: number;
  /** Last-updated timestamp (ms since epoch). */
  updatedAt: number;
}

/** Shape persisted to localStorage. */
interface StoredAnnotation {
  wallet: string;
  txHash: string;
  /** Either plaintext note or base64 ciphertext, depending on `encrypted`. */
  payload: string;
  encrypted: boolean;
  /** Base64 salt for PBKDF2 (only when encrypted). */
  salt?: string;
  /** Base64 IV for AES-GCM (only when encrypted). */
  iv?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoredEnvelope {
  version: 1;
  annotations: StoredAnnotation[];
}

const STORAGE_KEY = "tx-annotations:v1";
const PBKDF2_ITERATIONS = 150_000;

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function getStorage(): Storage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Access can throw in privacy-restricted contexts.
    return null;
  }
}

function readEnvelope(): StoredEnvelope {
  const storage = getStorage();
  if (!storage) return { version: 1, annotations: [] };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { version: 1, annotations: [] };
    const parsed = JSON.parse(raw) as StoredEnvelope;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.annotations)) {
      return { version: 1, annotations: [] };
    }
    return parsed;
  } catch {
    return { version: 1, annotations: [] };
  }
}

function writeEnvelope(envelope: StoredEnvelope): void {
  const storage = getStorage();
  if (!storage) return;
  storage.setItem(STORAGE_KEY, JSON.stringify(envelope));
}

/** Normalize a wallet address for consistent keying. */
export function normalizeWallet(wallet: string): string {
  return (wallet ?? "").trim().toLowerCase();
}

/** Normalize a transaction hash for consistent keying. */
export function normalizeTxHash(txHash: string): string {
  return (txHash ?? "").trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Crypto helpers (optional encryption at rest)
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function getCrypto(): Crypto {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (!c || !c.subtle) {
    throw new Error("WebCrypto is unavailable; cannot encrypt annotations.");
  }
  return c;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
): Promise<CryptoKey> {
  const crypto = getCrypto();
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptNote(
  note: string,
  passphrase: string,
): Promise<{ payload: string; salt: string; iv: string }> {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as unknown as BufferSource },
    key,
    enc.encode(note),
  );
  return {
    payload: toBase64(new Uint8Array(ciphertext)),
    salt: toBase64(salt),
    iv: toBase64(iv),
  };
}

async function decryptNote(
  stored: StoredAnnotation,
  passphrase: string,
): Promise<string> {
  if (!stored.salt || !stored.iv) {
    throw new Error("Encrypted annotation is missing salt or IV.");
  }
  const crypto = getCrypto();
  const key = await deriveKey(passphrase, fromBase64(stored.salt));
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(stored.iv) as unknown as BufferSource },
    key,
    fromBase64(stored.payload) as unknown as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface UpsertOptions {
  /** When provided, the note is encrypted at rest with this passphrase. */
  passphrase?: string;
}

/**
 * Add or replace the annotation for (wallet, txHash).
 * Returns the resulting in-memory annotation.
 */
export async function upsertAnnotation(
  wallet: string,
  txHash: string,
  note: string,
  options: UpsertOptions = {},
): Promise<Annotation> {
  const w = normalizeWallet(wallet);
  const h = normalizeTxHash(txHash);
  if (!w) throw new Error("Wallet address is required.");
  if (!h) throw new Error("Transaction hash is required.");

  const envelope = readEnvelope();
  const now = Date.now();
  const existingIndex = envelope.annotations.findIndex(
    (a) => a.wallet === w && a.txHash === h,
  );
  const createdAt =
    existingIndex >= 0 ? envelope.annotations[existingIndex].createdAt : now;

  let stored: StoredAnnotation;
  if (options.passphrase) {
    const { payload, salt, iv } = await encryptNote(note, options.passphrase);
    stored = {
      wallet: w,
      txHash: h,
      payload,
      encrypted: true,
      salt,
      iv,
      createdAt,
      updatedAt: now,
    };
  } else {
    stored = {
      wallet: w,
      txHash: h,
      payload: note,
      encrypted: false,
      createdAt,
      updatedAt: now,
    };
  }

  if (existingIndex >= 0) {
    envelope.annotations[existingIndex] = stored;
  } else {
    envelope.annotations.push(stored);
  }
  writeEnvelope(envelope);

  return { wallet: w, txHash: h, note, createdAt, updatedAt: now };
}

/**
 * Retrieve the annotation for (wallet, txHash), or null if none exists.
 * If the stored annotation is encrypted, `passphrase` is required.
 */
export async function getAnnotation(
  wallet: string,
  txHash: string,
  passphrase?: string,
): Promise<Annotation | null> {
  const w = normalizeWallet(wallet);
  const h = normalizeTxHash(txHash);
  const envelope = readEnvelope();
  const stored = envelope.annotations.find(
    (a) => a.wallet === w && a.txHash === h,
  );
  if (!stored) return null;
  return materialize(stored, passphrase);
}

/**
 * List all annotations for a single wallet. Annotations belonging to other
 * wallets are never returned, ensuring wallet-switch isolation.
 * Encrypted entries require `passphrase`; if omitted they are skipped.
 */
export async function listAnnotations(
  wallet: string,
  passphrase?: string,
): Promise<Annotation[]> {
  const w = normalizeWallet(wallet);
  const envelope = readEnvelope();
  const result: Annotation[] = [];
  for (const stored of envelope.annotations) {
    if (stored.wallet !== w) continue;
    const materialized = await materialize(stored, passphrase, true);
    if (materialized) result.push(materialized);
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Delete the annotation for (wallet, txHash). Returns true if something was
 * removed. Only the matching wallet's entry is affected.
 */
export function deleteAnnotation(wallet: string, txHash: string): boolean {
  const w = normalizeWallet(wallet);
  const h = normalizeTxHash(txHash);
  const envelope = readEnvelope();
  const before = envelope.annotations.length;
  envelope.annotations = envelope.annotations.filter(
    (a) => !(a.wallet === w && a.txHash === h),
  );
  const removed = envelope.annotations.length !== before;
  if (removed) writeEnvelope(envelope);
  return removed;
}

/** Remove every annotation belonging to a wallet. Returns count removed. */
export function clearWalletAnnotations(wallet: string): number {
  const w = normalizeWallet(wallet);
  const envelope = readEnvelope();
  const before = envelope.annotations.length;
  envelope.annotations = envelope.annotations.filter((a) => a.wallet !== w);
  const removed = before - envelope.annotations.length;
  if (removed > 0) writeEnvelope(envelope);
  return removed;
}

export interface ExportResult {
  wallet: string;
  exportedAt: number;
  annotations: Array<{
    txHash: string;
    note: string;
    createdAt: number;
    updatedAt: number;
  }>;
}

/**
 * Build an export payload for the given wallet. Only that wallet's annotations
 * are included. Encrypted entries are decrypted when `passphrase` is supplied;
 * if it is missing, encrypted entries are omitted from the export rather than
 * leaking ciphertext. This function does not mutate stored state.
 */
export async function exportAnnotations(
  wallet: string,
  passphrase?: string,
): Promise<ExportResult> {
  const w = normalizeWallet(wallet);
  const envelope = readEnvelope();
  const annotations: ExportResult["annotations"] = [];
  for (const stored of envelope.annotations) {
    if (stored.wallet !== w) continue;
    const materialized = await materialize(stored, passphrase, true);
    if (!materialized) continue;
    annotations.push({
      txHash: materialized.txHash,
      note: materialized.note,
      createdAt: materialized.createdAt,
      updatedAt: materialized.updatedAt,
    });
  }
  annotations.sort((a, b) => b.updatedAt - a.updatedAt);
  return { wallet: w, exportedAt: Date.now(), annotations };
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function materialize(
  stored: StoredAnnotation,
  passphrase: string | undefined,
  skipOnError = false,
): Promise<Annotation | null> {
  let note: string;
  if (stored.encrypted) {
    if (!passphrase) {
      if (skipOnError) return null;
      throw new Error("Passphrase required to read encrypted annotation.");
    }
    try {
      note = await decryptNote(stored, passphrase);
    } catch (err) {
      if (skipOnError) return null;
      throw err;
    }
  } else {
    note = stored.payload;
  }
  return {
    wallet: stored.wallet,
    txHash: stored.txHash,
    note,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  };
}