import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { sseService } from '../services/sse.service';
import { logger } from '../lib/logger';

/**
 * Session inventory for wallet-authenticated sessions.
 *
 * Sessions are tracked by an opaque session identifier. We never persist
 * signing secrets, private keys, or raw signatures in the session record.
 * Only metadata required to display and revoke a session is stored.
 *
 * Session expiry: sessions expire at `expiresAt`. Expired sessions are
 * treated as inactive and cannot be used to authenticate. Revoked sessions
 * (`revokedAt` set) are immediately invalid for both API and SSE access.
 */

interface SessionMetadata {
  userAgent?: string | null;
  ipAddress?: string | null;
}

interface SerializedSession {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent: string | null;
  ipAddress: string | null;
}

function serializeSession(session: {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  userAgent?: string | null;
  ipAddress?: string | null;
}): SerializedSession {
  return {
    id: session.id,
    createdAt: session.createdAt,
    lastSeenAt: session.lastSeenAt,
    expiresAt: session.expiresAt,
    revokedAt: session.revokedAt,
    userAgent: session.userAgent ?? null,
    ipAddress: session.ipAddress ?? null,
  };
}

function getAuthenticatedWallet(req: Request): string | null {
  const wallet = (req as Request & { wallet?: string }).wallet;
  if (!wallet || typeof wallet !== 'string') {
    return null;
  }
  return wallet;
}

/**
 * GET /api/user/sessions
 * List active sessions for the authenticated wallet.
 */
export async function listSessions(req: Request, res: Response): Promise<void> {
  const wallet = getAuthenticatedWallet(req);
  if (!wallet) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const now = new Date();
    const sessions = await prisma.walletSession.findMany({
      where: {
        walletAddress: wallet,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        userAgent: true,
        ipAddress: true,
      },
    });

    res.status(200).json({
      sessions: sessions.map(serializeSession),
    });
  } catch (error) {
    logger.error('Failed to list wallet sessions', { error, wallet });
    res.status(500).json({ error: 'Failed to list sessions' });
  }
}

/**
 * DELETE /api/user/sessions/:sessionId
 * Revoke a session belonging to the authenticated wallet.
 */
export async function revokeSession(req: Request, res: Response): Promise<void> {
  const wallet = getAuthenticatedWallet(req);
  if (!wallet) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }

  try {
    const session = await prisma.walletSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        walletAddress: true,
        revokedAt: true,
      },
    });

    // Do not reveal whether a session exists for another wallet.
    if (!session || session.walletAddress !== wallet) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    if (session.revokedAt) {
      // Idempotent: already revoked.
      res.status(200).json({ id: session.id, revokedAt: session.revokedAt });
      return;
    }

    const revokedAt = new Date();
    const updated = await prisma.walletSession.update({
      where: { id: session.id },
      data: { revokedAt },
      select: { id: true, revokedAt: true },
    });

    // Immediately close any SSE connections tied to this session.
    try {
      sseService.revokeSessionConnections(session.id);
    } catch (sseError) {
      logger.error('Failed to revoke SSE connections for session', {
        error: sseError,
        sessionId: session.id,
      });
    }

    res.status(200).json({ id: updated.id, revokedAt: updated.revokedAt });
  } catch (error) {
    logger.error('Failed to revoke wallet session', { error, wallet, sessionId });
    res.status(500).json({ error: 'Failed to revoke session' });
  }
}

/**
 * GET /api/user/sessions/:sessionId
 * Get a single session belonging to the authenticated wallet.
 */
export async function getSession(req: Request, res: Response): Promise<void> {
  const wallet = getAuthenticatedWallet(req);
  if (!wallet) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { sessionId } = req.params;
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'Invalid session id' });
    return;
  }

  try {
    const session = await prisma.walletSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        walletAddress: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        revokedAt: true,
        userAgent: true,
        ipAddress: true,
      },
    });

    if (!session || session.walletAddress !== wallet) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    res.status(200).json({ session: serializeSession(session) });
  } catch (error) {
    logger.error('Failed to get wallet session', { error, wallet, sessionId });
    res.status(500).json({ error: 'Failed to get session' });
  }
}

/**
 * POST /api/user/sessions/revoke-all
 * Revoke all active sessions for the authenticated wallet, optionally
 * keeping the current session.
 */
export async function revokeAllSessions(req: Request, res: Response): Promise<void> {
  const wallet = getAuthenticatedWallet(req);
  if (!wallet) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const keepSessionId =
    typeof req.body?.keepSessionId === 'string' ? req.body.keepSessionId : null;

  try {
    const now = new Date();
    const activeSessions = await prisma.walletSession.findMany({
      where: {
        walletAddress: wallet,
        revokedAt: null,
        expiresAt: { gt: now },
        ...(keepSessionId ? { id: { not: keepSessionId } } : {}),
      },
      select: { id: true },
    });

    const revokedAt = new Date();
    if (activeSessions.length > 0) {
      await prisma.walletSession.updateMany({
        where: { id: { in: activeSessions.map((s) => s.id) } },
        data: { revokedAt },
      });

      for (const session of activeSessions) {
        try {
          sseService.revokeSessionConnections(session.id);
        } catch (sseError) {
          logger.error('Failed to revoke SSE connections for session', {
            error: sseError,
            sessionId: session.id,
          });
        }
      }
    }

    res.status(200).json({
      revokedCount: activeSessions.length,
      revokedAt,
    });
  } catch (error) {
    logger.error('Failed to revoke all wallet sessions', { error, wallet });
    res.status(500).json({ error: 'Failed to revoke sessions' });
  }
}

export const userController = {
  listSessions,
  getSession,
  revokeSession,
  revokeAllSessions,
};