import { describe, it, expect, vi, beforeEach } from 'vitest';
import { subscribe } from '../src/controllers/sse.controller.js';
import { sseService } from '../src/services/sse.service.js';
import { prisma } from '../src/lib/prisma.js';
import type { Request, Response } from 'express';

vi.mock('../src/services/sse.service.js', () => ({
  sseService: {
    isShuttingDown: vi.fn(),
    checkCapacity: vi.fn(),
    addClient: vi.fn(),
  },
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    stream: {
      findMany: vi.fn(),
    },
  },
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a signed SSE ticket for the given public key and subscriptions so
 * tests can exercise the full subscribe() code path (ticket → ownership check
 * → addClient) without routing through HTTP.
 */
import { signSseTicket } from '../src/middleware/auth.js';

function makeTicket(publicKey: string, streams: string[] = [], users: string[] = []): string {
  return signSseTicket({ publicKey, streams, users });
}

const GUSER1 = 'GUSER1';
const GCOUNTER = 'GCOUNTER';
const GOTHER = 'GOTHER';

// ─── tests ───────────────────────────────────────────────────────────────────

describe('SSE Controller', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      headers: {},
      query: {},
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' } as any,
    };
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      writeHead: vi.fn().mockReturnThis(),
      write: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      on: vi.fn(),
    };
  });

  it('should return 503 if shutting down', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(true);

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('should reject subscriptions for a different configured Stellar network', async () => {
    const configuredNetwork = process.env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet';
    req.query = { network: configuredNetwork === 'mainnet' ? 'testnet' : 'mainnet' };

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'NETWORK_MISMATCH' }));
    expect(sseService.checkCapacity).not.toHaveBeenCalled();
  });

  it('should return 503 if over capacity', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: false, status: 503, message: 'Too many connections' });
    (prisma.stream.findMany as any).mockResolvedValue([]);

    req.query = { ticket: makeTicket(GUSER1) };

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: 'Too many connections' }));
  });

  it('should subscribe and add client to sseService', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (prisma.stream.findMany as any).mockResolvedValue([{ streamId: BigInt(1), sender: GUSER1, recipient: GOTHER }]);

    req.query = { ticket: makeTicket(GUSER1, ['1']) };

    await subscribe(req as Request, res as Response);

    expect(res.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
    expect(sseService.addClient).toHaveBeenCalled();
  });

  it('should include user subscriptions when users query params are provided', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (prisma.stream.findMany as any).mockResolvedValue([
      { streamId: BigInt(1), sender: GUSER1, recipient: GCOUNTER },
    ]);

    req.query = { ticket: makeTicket(GUSER1, ['1'], [GCOUNTER, GOTHER]) };

    await subscribe(req as Request, res as Response);

    // addClient is called with (clientId, res, subscriptions, ip, userId, lastEventId)
    const subscriptions = (sseService.addClient as any).mock.calls[0][2] as string[];
    expect(subscriptions).toContain('1');
    expect(subscriptions).toContain('user:GUSER1');
    expect(subscriptions).toContain('user:GCOUNTER');
    // GOTHER is not a stream participant, so it must be filtered out
    expect(subscriptions).not.toContain('user:GOTHER');
  });

  it('should pass Last-Event-ID to addClient for replay', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (prisma.stream.findMany as any).mockResolvedValue([
      { streamId: BigInt(1), sender: GUSER1, recipient: GOTHER },
    ]);

    req.query = { ticket: makeTicket(GUSER1, ['1']) };
    req.headers = { 'last-event-id': '42' };

    await subscribe(req as Request, res as Response);

    // The 6th argument to addClient is lastEventId
    const lastEventIdArg = (sseService.addClient as any).mock.calls[0][5];
    expect(lastEventIdArg).toBe(42);
  });

  it('should pass null lastEventId when no Last-Event-ID header', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (prisma.stream.findMany as any).mockResolvedValue([
      { streamId: BigInt(1), sender: GUSER1, recipient: GOTHER },
    ]);

    req.query = { ticket: makeTicket(GUSER1, ['1']) };

    await subscribe(req as Request, res as Response);

    const lastEventIdArg = (sseService.addClient as any).mock.calls[0][5];
    expect(lastEventIdArg).toBeNull();
  });

  it('should handle zod validation error for invalid ticket (non-string)', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    req.query = { ticket: ['not-a-string', 'another'] as any };

    await subscribe(req as Request, res as Response);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should include allowed users query subscriptions', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    (prisma.stream.findMany as any).mockResolvedValue([
      { streamId: BigInt(1), sender: GUSER1, recipient: GCOUNTER },
    ]);

    req.query = { ticket: makeTicket(GUSER1, ['1'], [GCOUNTER, GOTHER]) };

    await subscribe(req as Request, res as Response);

    const subscriptions = (sseService.addClient as any).mock.calls[0][2] as string[];
    expect(subscriptions).toContain('user:GUSER1');
    expect(subscriptions).toContain('user:GCOUNTER');
    expect(subscriptions).not.toContain('user:GOTHER');
  });

  it('should cap owned streams to MAX_SSE_STREAMS on reconnect (Issue #1246)', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });

    // Simulate a wallet with more streams than the cap
    const manyStreams = Array.from({ length: 500 }, (_, i) => ({
      streamId: BigInt(i + 1),
      sender: GUSER1,
      recipient: `GOTHER${i}`,
    }));

    // The controller should request take: MAX_SSE_STREAMS (500)
    (prisma.stream.findMany as any).mockResolvedValue(manyStreams);

    req.query = { ticket: makeTicket(GUSER1) };

    await subscribe(req as Request, res as Response);

    // Verify the query was bounded
    const findManyCall = (prisma.stream.findMany as any).mock.calls[0];
    expect(findManyCall[0].take).toBe(500);

    // The subscriptions should only contain the capped set + user subscription
    const subscriptions = (sseService.addClient as any).mock.calls[0][2] as string[];
    expect(subscriptions.length).toBeLessThanOrEqual(501); // 500 streams + user:GUSER1
  });

  it('should filter ticket streams not owned by the user (Issue 2: re-verify ownership)', async () => {
    (sseService.isShuttingDown as any).mockReturnValue(false);
    (sseService.checkCapacity as any).mockReturnValue({ allowed: true });
    // User owns stream 1 but not stream 999
    (prisma.stream.findMany as any).mockResolvedValue([
      { streamId: BigInt(1), sender: GUSER1, recipient: GOTHER },
    ]);

    // Ticket was issued for streams 1 AND 999 — but 999 is not actually owned now
    req.query = { ticket: makeTicket(GUSER1, ['1', '999']) };

    await subscribe(req as Request, res as Response);

    const subscriptions = (sseService.addClient as any).mock.calls[0][2] as string[];
    expect(subscriptions).toContain('1');
    // Stream 999 must be filtered out at connect time
    expect(subscriptions).not.toContain('999');
  });
});
