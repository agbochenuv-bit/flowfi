import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('JWT helpers', () => {
  const JWT_SECRET = 'test-jwt-secret';
  let signJwt: (payload: object) => string;
  let verifyJwt: (token: string) => { publicKey: string } | null;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('JWT_SECRET', JWT_SECRET);

    const auth = await import('../src/middleware/auth.js');
    signJwt = auth.signJwt;
    verifyJwt = auth.verifyJwt;
  });

  it('round-trips through verifyJwt', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });

    expect(verifyJwt(token)).toEqual({ publicKey: 'GTESTPUBLICKEY123' });
  });

  it('returns null for a tampered header', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });
    const parts = token.split('.') as [string, string, string];
    parts[0] = parts[0].slice(0, -1) + (parts[0].slice(-1) === 'A' ? 'B' : 'A');

    expect(verifyJwt(parts.join('.'))).toBeNull();
  });

  it('returns null for a tampered body', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });
    const parts = token.split('.') as [string, string, string];
    parts[1] = parts[1].slice(0, -1) + (parts[1].slice(-1) === 'A' ? 'B' : 'A');

    expect(verifyJwt(parts.join('.'))).toBeNull();
  });

  it('returns null for a tampered signature', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' });
    const parts = token.split('.') as [string, string, string];
    // Replace the signature with invalid data to ensure verification fails
    parts[2] = 'invalid-signature-data-1234567890abcdef';

    expect(verifyJwt(parts.join('.'))).toBeNull();
  });

  it('returns null for an expired token', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now - 3600, exp: now - 1, iss: 'flowfi-api', aud: 'flowfi-api' });

    expect(verifyJwt(token)).toBeNull();
  });

  it('returns null for a token with wrong audience', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'wrong-audience' });

    expect(verifyJwt(token)).toBeNull();
  });

  it('returns null for a token with wrong issuer', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'wrong-issuer', aud: 'flowfi-api' });

    expect(verifyJwt(token)).toBeNull();
  });

  it('returns null for a malformed token missing dots', async () => {
    expect(verifyJwt('abc.def')).toBeNull();
  });

  it('returns null for an entirely fabricated string', async () => {
    expect(verifyJwt('totally.fake.token')).toBeNull();
  });
});

describe('JWT signing-key rotation', () => {
  const OLD_SECRET = 'test-jwt-secret-old';
  const NEW_SECRET = 'test-jwt-secret-new';
  const RETIRED_SECRET = 'test-jwt-secret-retired';

  type AuthModule = typeof import('../src/middleware/auth.js');

  async function loadAuth(env: Record<string, string | undefined>): Promise<AuthModule> {
    vi.resetModules();
    for (const [key, value] of Object.entries(env)) {
      vi.stubEnv(key, value);
    }
    return import('../src/middleware/auth.js');
  }

  function payload(overrides: object = {}) {
    const now = Math.floor(Date.now() / 1000);
    return { sub: 'GTESTPUBLICKEY123', iat: now, exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api', ...overrides };
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('accepts tokens signed by the active key', async () => {
    const auth = await loadAuth({ JWT_SECRET: NEW_SECRET });
    const token = auth.signJwt(payload());

    expect(auth.verifyJwt(token)).toEqual({ publicKey: 'GTESTPUBLICKEY123' });
  });

  it('accepts tokens signed by an overlap key during rotation', async () => {
    const oldAuth = await loadAuth({ JWT_SECRET: OLD_SECRET });
    const inFlight = oldAuth.signJwt(payload());

    const rotated = await loadAuth({
      JWT_SECRET: NEW_SECRET,
      JWT_OVERLAP_SECRETS: OLD_SECRET,
    });

    expect(rotated.verifyJwt(inFlight)).toEqual({ publicKey: 'GTESTPUBLICKEY123' });
  });

  it('signs new tokens with the active key, not the overlap key', async () => {
    const rotated = await loadAuth({
      JWT_SECRET: NEW_SECRET,
      JWT_OVERLAP_SECRETS: OLD_SECRET,
    });
    const token = rotated.signJwt(payload());
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8'));

    expect(header.kid).toBe(rotated.getActiveKeyId());
    expect(rotated.getActiveKeyId()).not.toBe(rotated.getKeyIdForSecret(OLD_SECRET));
  });

  it('rejects tokens signed by a retired key', async () => {
    const retiredAuth = await loadAuth({ JWT_SECRET: RETIRED_SECRET });
    const retiredToken = retiredAuth.signJwt(payload());

    const current = await loadAuth({
      JWT_SECRET: NEW_SECRET,
      JWT_OVERLAP_SECRETS: OLD_SECRET,
    });

    expect(current.verifyJwt(retiredToken)).toBeNull();
  });

  it('rejects tokens with an unknown kid', async () => {
    const auth = await loadAuth({ JWT_SECRET: NEW_SECRET });
    const token = auth.signJwt(payload());
    const [header, body, signature] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    decoded.kid = 'unknown-key-id';
    const forgedHeader = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(auth.verifyJwt([forgedHeader, body, signature].join('.'))).toBeNull();
  });

  it('rejects tokens with a missing kid', async () => {
    const auth = await loadAuth({ JWT_SECRET: NEW_SECRET });
    const token = auth.signJwt(payload());
    const [header, body, signature] = token.split('.') as [string, string, string];
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    delete decoded.kid;
    const forgedHeader = Buffer.from(JSON.stringify(decoded)).toString('base64url');

    expect(auth.verifyJwt([forgedHeader, body, signature].join('.')).toBeNull();
  });

  it('keeps in-flight tokens valid across a rotation', async () => {
    const before = await loadAuth({ JWT_SECRET: OLD_SECRET });
    const inFlight = before.signJwt(payload());

    const during = await loadAuth({ JWT_SECRET: NEW_SECRET, JWT_OVERLAP_SECRETS: OLD_SECRET });
    expect(during.verifyJwt(inFlight)).toEqual({ publicKey: 'GTESTPUBLICKEY123' });

    const after = await loadAuth({ JWT_SECRET: NEW_SECRET });
    expect(after.verifyJwt(inFlight)).toBeNull();
  });

  it('does not expose secrets in diagnostics', async () => {
    const auth = await loadAuth({
      JWT_SECRET: NEW_SECRET,
      JWT_OVERLAP_SECRETS: OLD_SECRET,
    });

    const diagnostics = JSON.stringify(auth.getKeyDiagnostics());
    expect(diagnostics).not.toContain(NEW_SECRET);
    expect(diagnostics).not.toContain(OLD_SECRET);
    expect(diagnostics).toContain(auth.getActiveKeyId());
  });

  it('does not expose secrets when verification fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const auth = await loadAuth({ JWT_SECRET: NEW_SECRET });
    expect(auth.verifyJwt('totally.fake.token')).toBeNull();

    const emitted = [...warn.mock.calls, ...error.mock.calls, ...log.mock.calls]
      .map((args) => args.map(String).join(' '))
      .join('\n');
    expect(emitted).not.toContain(NEW_SECRET);

    warn.mockRestore();
    error.mockRestore();
    log.mockRestore();
  });
});
