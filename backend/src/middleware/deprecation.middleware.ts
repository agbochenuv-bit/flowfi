import type { Request, Response, NextFunction } from 'express';

/**
 * Configuration for a deprecated route or route group.
 */
export interface DeprecationConfig {
  /**
   * ISO 8601 date on which the route will be removed (e.g. "2026-01-01").
   * Surfaced as `X-API-Sunset-Date` so clients can plan migration.
   */
  sunsetDate: string;
  /**
   * URL or path pointing to the replacement endpoint or migration guide.
   * Surfaced as `X-API-Migration-Path`.
   */
  migrationPath: string;
  /**
   * Human-readable deprecation notice.
   * Surfaced as `X-API-Deprecated`.
   */
  notice?: string;
}

/**
 * Express middleware factory that adds standardised deprecation headers to
 * every response for the route(s) it is applied to:
 *
 *   X-API-Deprecated:    "true" (or the custom notice when provided)
 *   X-API-Sunset-Date:   ISO 8601 date after which the endpoint will be removed
 *   X-API-Migration-Path: URL or path describing where to find the replacement
 *
 * Usage — apply to a single route:
 *
 *   router.get('/old-endpoint',
 *     deprecationMiddleware({ sunsetDate: '2026-01-01', migrationPath: '/v2/new-endpoint' }),
 *     handler,
 *   );
 *
 * Usage — apply to all routes on a router:
 *
 *   router.use(deprecationMiddleware({ sunsetDate: '2026-01-01', migrationPath: '/v2/...' }));
 */
export function deprecationMiddleware(config: DeprecationConfig) {
  return function addDeprecationHeaders(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    res.setHeader('X-API-Deprecated', config.notice ?? 'true');
    res.setHeader('X-API-Sunset-Date', config.sunsetDate);
    res.setHeader('X-API-Migration-Path', config.migrationPath);
    next();
  };
}
