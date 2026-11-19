import { Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { cache } from '../lib/cache';
import { emitDomainEvent } from '../lib/domain-events';

const prisma = new PrismaClient();

/**
 * User summary cache invalidation is driven by committed domain events.
 *
 * Mutations in this controller do NOT call `cache.del` inline. Instead, after a
 * successful mutation we emit a `user.summary.invalidated` domain event through
 * the post-commit helper in `../lib/domain-events`. The helper defers delivery
 * until the surrounding database transaction commits, so:
 *   - On commit: the event fires and the cached summary is invalidated.
 *   - On rollback: the event is discarded and the cache is left untouched,
 *     preventing stale responses after a failed mutation.
 *   - Duplicate events: invalidation is idempotent (deleting an already-absent
 *     key is a no-op), so repeated events are safe.
 *
 * Cache consistency guarantee: a cached user summary is only ever invalidated
 * after the underlying write is durably committed. Readers may observe the
 * previous summary until the commit completes, but never a summary that
 * reflects a rolled-back write.
 */

interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function summaryCacheKey(userId: string): string {
  return `user:summary:${userId}`;
}

function toSummary(user: {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}): UserSummary {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

export async function registerUser(req: Request, res: Response): Promise<void> {
  const { email, name, password } = req.body ?? {};

  if (!email || typeof email !== 'string') {
    res.status(400).json({ error: 'email is required' });
    return;
  }
  if (!password || typeof password !== 'string') {
    res.status(400).json({ error: 'password is required' });
    return;
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: name ?? null,
          password,
        },
      });

      // Emit through the post-commit helper, passing the transaction client so
      // the event is only delivered after this transaction commits.
      await emitDomainEvent(
        'user.summary.invalidated',
        { userId: created.id },
        tx,
      );

      return created;
    });

    res.status(201).json(toSummary(user));
  } catch (err) {
    res.status(500).json({ error: 'failed to register user' });
  }
}

export async function updateUser(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { email, name } = req.body ?? {};

  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  try {
    const user = await prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          ...(email !== undefined ? { email } : {}),
          ...(name !== undefined ? { name } : {}),
        },
      });

      // Emit through the post-commit helper, passing the transaction client so
      // the event is only delivered after this transaction commits.
      await emitDomainEvent(
        'user.summary.invalidated',
        { userId: updated.id },
        tx,
      );

      return updated;
    });

    res.status(200).json(toSummary(user));
  } catch (err: any) {
    if (err?.code === 'P2025') {
      res.status(404).json({ error: 'user not found' });
      return;
    }
    res.status(500).json({ error: 'failed to update user' });
  }
}

export async function getUserSummary(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  if (!id) {
    res.status(400).json({ error: 'id is required' });
    return;
  }

  try {
    const key = summaryCacheKey(id);
    const cached = await cache.get(key);
    if (cached) {
      res.status(200).json(JSON.parse(cached));
      return;
    }

    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) {
      res.status(404).json({ error: 'user not found' });
      return;
    }

    const summary = toSummary(user);
    await cache.set(key, JSON.stringify(summary));
    res.status(200).json(summary);
  } catch (err) {
    res.status(500).json({ error: 'failed to load user summary' });
  }
}