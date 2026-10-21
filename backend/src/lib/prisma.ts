import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/index.js';
import { createPgPool } from './pg-pool.js';

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
  pool?: pg.Pool;
};

if (!globalForPrisma.pool) {
  globalForPrisma.pool = createPgPool();
}

const adapter = new PrismaPg(globalForPrisma.pool);

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter,
    // Query logging can expose bearer tokens, signatures, and webhook secrets
    // through bound parameters. Keep errors/warnings, never SQL query events.
    log: ['error', 'warn'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export { getPoolMetrics } from './pg-pool.js';
export const pool = globalForPrisma.pool!;

export default prisma;
