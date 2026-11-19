import { afterEach, expect, it, vi } from 'vitest';

function loadKeySet(keys: Record<string, string>, active: string) {
  vi.resetModules();
  vi.stubEnv('JWT_KEYS', JSON.stringify(keys));
  vi.stubEnv('JWT_ACTIVE_KID', active);
  return import('../src/middleware/auth.js');
}

afterEach(() => vi.unstubAllEnvs());

it('preserves sessions during overlap and rejects the retired key after rollout', async () => {
  const now = Math.floor(Date.now() / 1000);
  const session = { sub: 'GTEST', exp: now + 3600, iss: 'flowfi-api', aud: 'flowfi-api' };
  const old = await loadKeySet({ old: 'fixture-old' }, 'old');
  const oldToken = old.signJwt(session);

  const overlap = await loadKeySet({ old: 'fixture-old', next: 'fixture-next' }, 'next');
  const newToken = overlap.signJwt(session);
  expect(overlap.getActiveJwtKid()).toBe('next');
  expect(overlap.verifyJwt(oldToken)).toEqual({ publicKey: 'GTEST' });

  const retired = await loadKeySet({ next: 'fixture-next' }, 'next');
  expect(retired.verifyJwt(oldToken)).toBeNull();
  expect(retired.verifyJwt(newToken)).toEqual({ publicKey: 'GTEST' });
});

it('rejects a rollout with the active key absent from the verification set', async () => {
  await expect(loadKeySet({ old: 'fixture-old' }, 'next')).rejects.toThrow('is not present in JWT_KEYS');
});
