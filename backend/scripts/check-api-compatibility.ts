#!/usr/bin/env node
/**
 * Client API Compatibility Check
 *
 * Fetches the /health endpoint and validates that:
 *   1. The `apiVersions.supported` array includes every version the client
 *      declares as required.
 *   2. The `apiVersions.default` is a version the client knows about.
 *
 * Exits 0 when the running server is compatible with this client's pin; exits
 * 1 when at least one required version has been sunset or removed.
 *
 * Usage:
 *   # Check the local dev server (default)
 *   npx tsx scripts/check-api-compatibility.ts
 *
 *   # Check a remote environment
 *   API_URL=https://api.flowfi.io npx tsx scripts/check-api-compatibility.ts
 *
 *   # Require specific versions (space-separated)
 *   REQUIRED_API_VERSIONS="v1" npx tsx scripts/check-api-compatibility.ts
 *
 * Add to CI (GitHub Actions example):
 *   - name: API version compatibility gate
 *     run: npx tsx scripts/check-api-compatibility.ts
 *     working-directory: backend
 *     env:
 *       API_URL: ${{ vars.STAGING_API_URL }}
 *       REQUIRED_API_VERSIONS: v1
 */

import https from 'node:https';
import http from 'node:http';

// ─── Configuration ────────────────────────────────────────────────────────────

/** Base URL of the FlowFi backend. Override via API_URL env var. */
const API_URL = (process.env.API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

/**
 * Versions this client requires the server to still support.
 * Override via REQUIRED_API_VERSIONS env var (space-separated, e.g. "v1").
 * Defaults to ["v1"] — the only shipped version.
 */
const REQUIRED_VERSIONS: string[] = (
  process.env.REQUIRED_API_VERSIONS ?? 'v1'
)
  .split(/\s+/)
  .map((v) => v.trim())
  .filter(Boolean);

/** Timeout (ms) for the health request. */
const REQUEST_TIMEOUT_MS = 10_000;

// ─── Health endpoint shape ────────────────────────────────────────────────────

interface HealthResponse {
  status?: string;
  apiVersions?: {
    supported?: string[];
    default?: string;
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function get(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Request to ${url} timed out after ${timeoutMs}ms`));
    });
    req.on('error', reject);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const healthUrl = `${API_URL}/health`;
  console.log(`[api-compat] Checking ${healthUrl} …`);
  console.log(`[api-compat] Required versions: ${REQUIRED_VERSIONS.join(', ')}`);

  let body: string;
  try {
    body = await get(healthUrl, REQUEST_TIMEOUT_MS);
  } catch (err) {
    console.error(`[api-compat] FAILED — could not reach health endpoint: ${String(err)}`);
    process.exit(1);
  }

  let health: HealthResponse;
  try {
    health = JSON.parse(body) as HealthResponse;
  } catch {
    console.error('[api-compat] FAILED — health endpoint returned non-JSON response.');
    console.error(body.slice(0, 500));
    process.exit(1);
  }

  const supported = health.apiVersions?.supported ?? [];
  const defaultVersion = health.apiVersions?.default ?? '(unknown)';

  if (supported.length === 0) {
    console.error(
      '[api-compat] FAILED — health response does not include apiVersions.supported.\n' +
        '  This may mean the server is running an older build that predates the\n' +
        '  versioning policy. Upgrade the server or remove this check for that\n' +
        '  environment.',
    );
    process.exit(1);
  }

  console.log(`[api-compat] Server supports: ${supported.join(', ')} (default: ${defaultVersion})`);

  const missing = REQUIRED_VERSIONS.filter((v) => !supported.includes(v));

  if (missing.length > 0) {
    console.error(
      `[api-compat] FAILED — the following required API version(s) are no longer ` +
        `supported by the server: ${missing.join(', ')}`,
    );
    console.error(
      `[api-compat] Update your client to use one of the supported versions: ${supported.join(', ')}`,
    );
    process.exit(1);
  }

  // Warn if the server's default has changed (a newer default may mean the
  // client is behind but not yet broken).
  const clientKnowsDefault = REQUIRED_VERSIONS.includes(defaultVersion);
  if (!clientKnowsDefault) {
    console.warn(
      `[api-compat] WARNING — the server's default API version is now '${defaultVersion}', ` +
        `which is not in this client's required-versions list. Consider updating.`,
    );
  }

  console.log('[api-compat] PASSED — all required API versions are supported by the server.');
}

main().catch((err) => {
  console.error('[api-compat] Unexpected error:', err);
  process.exit(1);
});
