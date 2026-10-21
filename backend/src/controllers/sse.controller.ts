import type { Request, Response } from 'express';
import { sseService } from '../services/sse.service.js';
import { prisma } from '../lib/prisma.js';
import type { AuthenticatedRequest } from '../types/auth.types.js';
import { z } from 'zod';
import { getConfiguredStellarNetwork } from '../lib/stellar-network.js';
import { signSseTicket, verifySseTicket } from '../middleware/auth.js';

const subscribeSchema = z.object({
  streams: z.array(z.string().regex(/^\d+$/)).max(500).optional().default([]),
  users: z.array(z.string()).max(500).optional().default([]),
  all: z.boolean().optional().default(false),
});

/**
 * Issue #1246: hard cap on the number of streams fetched per SSE session.
 * Prevents unbounded DB queries when a wallet has thousands of streams.
 * Users who exceed this cap still receive events for the most recent streams;
 * the frontend can fall back to polling or pagination for the remainder.
 */
const MAX_SSE_STREAMS = 500;

export const createSseTicket = async (req: Request, res: Response) => {
  try {
    const { streams, users, all } = subscribeSchema.parse(req.body);
    const { publicKey } = (req as AuthenticatedRequest).user;
    const owned = await prisma.stream.findMany({
      where: { OR: [{ sender: publicKey }, { recipient: publicKey }] },
      orderBy: { startTime: 'desc' },
      take: MAX_SSE_STREAMS,
      select: { streamId: true, sender: true, recipient: true },
    });
    const ownedIds = new Set(owned.map((stream) => String(stream.streamId)));
    const allowedUsers = new Set<string>([publicKey]);
    for (const stream of owned) {
      allowedUsers.add(stream.sender);
      allowedUsers.add(stream.recipient);
    }
    const allowedStreams = all || streams.length === 0
      ? [...ownedIds]
      : streams.filter((id) => ownedIds.has(id));
    const allowedSubscriptions = [...new Set(users.filter((key) => allowedUsers.has(key)))];
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ticket: signSseTicket({ publicKey, streams: allowedStreams, users: allowedSubscriptions }) });
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ message: 'Invalid subscription parameters', errors: error.issues });
      return;
    }
    res.status(500).json({ message: 'Internal server error' });
  }
};


function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]?.trim() || 'unknown';
  }

  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0] ?? 'unknown';
  }

  return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Issue 1: Parse the `Last-Event-ID` HTTP header sent by the browser on
 * reconnect.  Returns the numeric ID, or null when absent or not a valid
 * positive integer.
 *
 * The browser automatically sets `Last-Event-ID` from the most recent `id:`
 * field it received.  We use a per-process monotonically increasing integer
 * as the ID so we can efficiently find the missed window in the replay buffer.
 */
function parseLastEventId(req: Request): number | null {
  const raw = req.headers['last-event-id'];
  if (!raw) return null;
  const str = Array.isArray(raw) ? raw[0] : raw;
  if (!str) return null;
  const n = Number.parseInt(str, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const subscribe = async (req: Request, res: Response) => {
  if (req.query.network !== undefined && req.query.network !== getConfiguredStellarNetwork()) {
    return res.status(409).json({
      code: 'NETWORK_MISMATCH',
      message: `This event stream serves ${getConfiguredStellarNetwork()}, not ${String(req.query.network)}.`,
    });
  }

  if (sseService.isShuttingDown()) {
    return res.status(503).json({ message: 'Server is shutting down, please reconnect shortly.' });
  }

  try {
    const rawTicket = req.query.ticket;
    const ticket = typeof rawTicket === 'string' ? verifySseTicket(rawTicket) : null;
    if (!ticket) {
      return res.status(401).json({ message: 'Missing, invalid, or expired SSE ticket' });
    }

    // Issue 2: re-verify stream ownership at connection time (defense-in-depth
    // on top of ticket issuance) so stale tickets from the 60-second issuance
    // window cannot subscribe to streams the user no longer owns.
    const { publicKey } = ticket;
    const sourceIp = getClientIp(req);

    const capacity = sseService.checkCapacity(sourceIp, publicKey);
    if (!capacity.allowed) {
      if (capacity.retryAfterSeconds) {
        res.setHeader('Retry-After', String(capacity.retryAfterSeconds));
      }
      return res.status(capacity.status ?? 503).json({
        message: capacity.message ?? 'SSE connection rejected',
      });
    }

    // Consistent with GET /v1/events/ (which requires requireAuth and is scoped to user's address),
    // SSE subscriptions are also restricted to streams owned by the authenticated user.
    // Scope: only streams where the authenticated user is sender or recipient
    // Issue #1246: cap the query to prevent unbounded fetches on reconnect.
    // Ordered by startTime desc so the most recent streams are always included
    // when the cap is reached.
    const ownedStreams = await prisma.stream.findMany({
      where: { OR: [{ sender: publicKey }, { recipient: publicKey }] },
      orderBy: { startTime: 'desc' },
      take: MAX_SSE_STREAMS,
      select: { streamId: true, sender: true, recipient: true },
    });
    const ownedIds = new Set(ownedStreams.map((s: { streamId: bigint }) => String(s.streamId)));
    const allowedUserKeys = new Set<string>([publicKey]);
    for (const stream of ownedStreams) {
      allowedUserKeys.add(stream.sender);
      allowedUserKeys.add(stream.recipient);
    }

    // Issue 2: intersect ticket's stream list with currently-owned IDs so a
    // ticket issued before a stream was transferred cannot grant continued access.
    const subscriptions: string[] = ticket.streams.filter((id) => ownedIds.has(id));

    // Issue 2: same intersection for user channels.
    const userSubscriptions = new Set<string>([`user:${publicKey}`]);
    for (const key of ticket.users.filter((k) => allowedUserKeys.has(k))) {
      userSubscriptions.add(`user:${key}`);
    }
    subscriptions.push(...userSubscriptions);

    // Issue 1: read Last-Event-ID from the HTTP header.
    const lastEventId = parseLastEventId(req);

    const clientId = `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

    sseService.addClient(clientId, res, subscriptions, sourceIp, publicKey, lastEventId);
    return;
  } catch (error: unknown) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({
        message: 'Invalid subscription parameters',
        errors: error.issues,
      });
    }
    return res.status(500).json({ message: 'Internal server error' });
  }
};
