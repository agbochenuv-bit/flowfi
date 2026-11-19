import path from 'node:path';
import { defineConfig } from 'prisma/config';

/**
 * Resolves the database URL for Prisma CLI operations.
 *
 * Startup semantics: fail-fast. If no database URL can be resolved from the
 * environment or a supported secret-manager reference, Prisma CLI commands
 * abort with a redacted error rather than continuing with an empty value.
 *
 * Secret-manager references are supported via `DATABASE_URL_SECRET_REF`
 * (e.g. `sm://prod/db/url`). When present, the referenced value is fetched
 * through the configured provider. The plaintext `DATABASE_URL` env var keeps
 * working as a fallback so existing setups are not broken.
 *
 * Failure semantics: if the provider is unavailable or returns a malformed
 * response, we surface a clear, redacted error. Secret material is never
 * logged.
 */

const SECRET_REF_PREFIX = 'sm://';

function redact(value: string | undefined): string {
  if (!value) return '<unset>';
  return '<redacted>';
}

async function resolveSecretRef(ref: string): Promise<string> {
  if (!ref.startsWith(SECRET_REF_PREFIX)) {
    throw new Error(
      `Unsupported secret reference scheme in DATABASE_URL_SECRET_REF (expected ${SECRET_REF_PREFIX}...)`,
    );
  }

  const key = ref.slice(SECRET_REF_PREFIX.length);
  if (!key) {
    throw new Error('DATABASE_URL_SECRET_REF is missing a secret key');
  }

  // Provider endpoint is optional; when unset we cannot resolve the reference.
  const providerUrl = process.env.SECRET_MANAGER_URL;
  if (!providerUrl) {
    throw new Error(
      'SECRET_MANAGER_URL is not configured; cannot resolve DATABASE_URL_SECRET_REF',
    );
  }

  let response: Response;
  try {
    response = await fetch(`${providerUrl.replace(/\/$/, '')}/secrets/${encodeURIComponent(key)}`, {
      headers: process.env.SECRET_MANAGER_TOKEN
        ? { Authorization: `Bearer ${process.env.SECRET_MANAGER_TOKEN}` }
        : undefined,
    });
  } catch (err) {
    throw new Error(
      `Secret manager unavailable while resolving DATABASE_URL_SECRET_REF (${redact(ref)}): ${
        err instanceof Error ? err.message : 'unknown error'
      }`,
    );
  }

  if (!response.ok) {
    throw new Error(
      `Secret manager returned ${response.status} while resolving DATABASE_URL_SECRET_REF (${redact(ref)})`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `Secret manager returned a malformed response for DATABASE_URL_SECRET_REF (${redact(ref)})`,
    );
  }

  const value =
    payload && typeof payload === 'object' && 'value' in payload
      ? (payload as { value?: unknown }).value
      : undefined;

  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `Secret manager response for DATABASE_URL_SECRET_REF (${redact(ref)}) is missing a non-empty "value"`,
    );
  }

  return value;
}

async function resolveDatabaseUrl(): Promise<string> {
  const ref = process.env.DATABASE_URL_SECRET_REF;
  if (ref) {
    return resolveSecretRef(ref);
  }

  const direct = process.env.DATABASE_URL;
  if (direct) {
    return direct;
  }

  throw new Error(
    'No database URL configured: set DATABASE_URL or DATABASE_URL_SECRET_REF',
  );
}

export default defineConfig(async () => ({
  schema: path.join('prisma', 'schema.prisma'),
  migrations: {
    path: path.join('prisma', 'migrations'),
  },
  datasource: {
    url: await resolveDatabaseUrl(),
  },
}));
