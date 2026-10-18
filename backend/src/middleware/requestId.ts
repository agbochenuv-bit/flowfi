import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import logger, { requestContext } from '../logger.js';

const SAFE_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STELLAR_PUBLIC_KEY_RE = /G[A-Z2-7]{55}/g;

function isValidRequestId(value: string): boolean {
  return SAFE_REQUEST_ID_PATTERN.test(value);
}

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-request-id'];
  const requestId = typeof header === 'string' && isValidRequestId(header) ? header : randomUUID();
  const safePath = req.path.replace(STELLAR_PUBLIC_KEY_RE, '[wallet]');

  res.setHeader('X-Request-ID', requestId);

  const startMs = Date.now();

  res.on('finish', () => {
    logger.info('response sent', {
      method: req.method,
      path: safePath,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
      requestId,
    });
  });

  requestContext.run({ requestId }, () => {
    logger.info('request received', { method: req.method, path: safePath, requestId });
    next();
  });
}
