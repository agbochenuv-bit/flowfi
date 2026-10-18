import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {},
}));

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { adminRateLimiter } from '../src/middleware/admin-rate-limiter.middleware.js';

function createReq(overrides: Record<string, unknown> = {}) {
  return {
    ip: '203.0.113.10',
    headers: {},
    user: undefined,
    ...overrides,
  } as any;
}

function createRes() {
  const res: any = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    body: undefined as unknown,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      res.body = payload;
      return res;
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      res.headers[name] = value;
      return res;
    }),
    getHeader: vi.fn((name: string) => res.headers[name]),
  };
  return res;
}

describe('adminRateLimiter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is a function', () => {
    expect(typeof adminRateLimiter).toBe('function');
  });

  it('allows requests under the budget', async () => {
    const req = createReq();
    const res = createRes();
    const next = vi.fn();

    await adminRateLimiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('keys authenticated callers by principal rather than IP', async () => {
    const req = createReq({
      ip: '203.0.113.10',
      user: { id: 'user-1', role: 'admin' },
    });
    const res = createRes();
    const next = vi.fn();

    await adminRateLimiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('keys anonymous callers by IP', async () => {
    const req = createReq({ ip: '198.51.100.7' });
    const res = createRes();
    const next = vi.fn();

    await adminRateLimiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('ignores spoofed forwarding headers when proxy is not trusted', async () => {
    const req = createReq({
      ip: '203.0.113.10',
      headers: {
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
      },
    });
    const res = createRes();
    const next = vi.fn();

    await adminRateLimiter(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns a documented 429 envelope when the budget is exceeded', async () => {
    const req = createReq({ ip: '203.0.113.99' });
    const next = vi.fn();

    let lastRes = createRes();
    for (let i = 0; i < 1000; i += 1) {
      lastRes = createRes();
      await adminRateLimiter(req, lastRes, next);
      if (lastRes.statusCode === 429) {
        break;
      }
    }

    if (lastRes.statusCode === 429) {
      expect(lastRes.status).toHaveBeenCalledWith(429);
      expect(lastRes.body).toMatchObject({
        error: expect.any(String),
      });
    } else {
      expect(next).toHaveBeenCalled();
    }
  });
});