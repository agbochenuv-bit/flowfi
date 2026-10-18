import type { Request, Response, NextFunction } from 'express';

/**
 * API Version middleware
 * Extracts and validates API version from request
 */
export interface VersionedRequest extends Request {
  apiVersion?: ApiVersion;
}

/**
 * Supported API versions
 */
export const SUPPORTED_VERSIONS = ['v1', 'v2'] as const;
export type ApiVersion = typeof SUPPORTED_VERSIONS[number];

/**
 * Default API version
 */
export const DEFAULT_VERSION: ApiVersion = 'v1';

/**
 * Pagination styles supported by the API.
 * - `offset`: legacy page/limit based pagination (default)
 * - `cursor`: opaque cursor pagination for high-volume stream/event lists
 */
export const PAGINATION_STYLES = ['offset', 'cursor'] as const;
export type PaginationStyle = typeof PAGINATION_STYLES[number];

/**
 * Default pagination style (legacy shape) used when no override is requested.
 */
export const DEFAULT_PAGINATION_STYLE: PaginationStyle = 'offset';

/**
 * Query parameter used to explicitly request a pagination style.
 */
export const PAGINATION_QUERY_PARAM = 'pagination';

/**
 * Query parameter used to override the API version (e.g. `?api-version=2`).
 */
export const API_VERSION_QUERY_PARAM = 'api-version';

/**
 * Versions that enable cursor pagination by default.
 */
export const CURSOR_PAGINATION_VERSIONS: readonly ApiVersion[] = ['v2'];

export interface VersionedRequest extends Request {
  apiVersion?: ApiVersion;
  paginationStyle?: PaginationStyle;
}

/**
 * Normalizes a raw version string (e.g. `v2`, `2`) into a supported ApiVersion.
 * Returns undefined when the value is not a supported version.
 */
export function normalizeApiVersion(raw: string | undefined): ApiVersion | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  const withPrefix = /^\d+$/.test(trimmed) ? `v${trimmed}` : trimmed;
  return SUPPORTED_VERSIONS.includes(withPrefix as ApiVersion)
    ? (withPrefix as ApiVersion)
    : undefined;
}

/**
 * Resolves the effective pagination style for a request.
 * Explicit `?pagination=` wins; otherwise the version default applies.
 * Absent/invalid values fall back to the legacy `offset` shape.
 */
export function resolvePaginationStyle(
  version: ApiVersion,
  rawPagination: string | undefined
): PaginationStyle {
  if (rawPagination) {
    const normalized = rawPagination.trim().toLowerCase();
    if (PAGINATION_STYLES.includes(normalized as PaginationStyle)) {
      return normalized as PaginationStyle;
    }
  }
  return CURSOR_PAGINATION_VERSIONS.includes(version)
    ? 'cursor'
    : DEFAULT_PAGINATION_STYLE;
}

/**
 * Middleware to extract API version from URL path
 * Expects routes like /v1/streams, /v2/streams, etc.
 */
export function apiVersionMiddleware(
  req: VersionedRequest,
  res: Response,
  next: NextFunction
): void {
  // Extract version from path (e.g., /v1/streams -> v1)
  const pathParts = req.path.split('/').filter(Boolean);
  const versionMatch = pathParts[0]?.match(/^v(\d+)$/);

  if (versionMatch) {
    const versionString = `v${versionMatch[1]}`;

    // Type guard to check if version is supported
    if (SUPPORTED_VERSIONS.includes(versionString as ApiVersion)) {
      const version = versionString as ApiVersion;
      req.apiVersion = version;
      // Remove version from path for route matching
      const queryString = req.url.includes('?') ? req.url.split('?')[1] : '';
      const newPath = '/' + pathParts.slice(1).join('/');
      req.url = newPath + (queryString ? '?' + queryString : '');
      // Note: req.path is read-only, but req.url modification affects routing
    } else {
      res.status(400).json({
        error: 'Unsupported API version',
        message: `API version '${versionString}' is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`,
        supportedVersions: SUPPORTED_VERSIONS,
      });
      return;
    }
  } else {
    // No version in path: allow an explicit `?api-version=` override.
    const rawOverride = req.query?.[API_VERSION_QUERY_PARAM];
    const overrideValue = Array.isArray(rawOverride)
      ? rawOverride[0]
      : rawOverride;

    if (typeof overrideValue === 'string' && overrideValue.trim() !== '') {
      const version = normalizeApiVersion(overrideValue);
      if (!version) {
        res.status(400).json({
          error: 'Unsupported API version',
          message: `API version '${overrideValue}' is not supported. Supported versions: ${SUPPORTED_VERSIONS.join(', ')}`,
          supportedVersions: SUPPORTED_VERSIONS,
        });
        return;
      }
      req.apiVersion = version;
    }
  }

  // Resolve pagination style (legacy `offset` shape unless explicitly opted in).
  const rawPagination = req.query?.[PAGINATION_QUERY_PARAM];
  const paginationValue = Array.isArray(rawPagination)
    ? rawPagination[0]
    : rawPagination;
  req.paginationStyle = resolvePaginationStyle(
    getApiVersion(req),
    typeof paginationValue === 'string' ? paginationValue : undefined
  );

  next();
}

/**
 * Helper to get API version from request
 */
export function getApiVersion(req: VersionedRequest): ApiVersion {
  return req.apiVersion || DEFAULT_VERSION;
}

/**
 * Helper to get the effective pagination style from request.
 * Defaults to the legacy `offset` shape when unset.
 */
export function getPaginationStyle(req: VersionedRequest): PaginationStyle {
  return req.paginationStyle || DEFAULT_PAGINATION_STYLE;
}
