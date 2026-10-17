import { describe, it, expect, vi, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { apiVersionMiddleware, getApiVersion, DEFAULT_VERSION } from '../src/middleware/api-version.middleware.js';
import type { Response, NextFunction } from 'express';
import type { VersionedRequest } from '../src/middleware/api-version.middleware.js';

describe('API Version Middleware', () => {
  let req: Partial<VersionedRequest>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();
    res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('should extract v1 from path and rewrite url', () => {
    req = { path: '/v1/streams', url: '/v1/streams' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(req.apiVersion).toBe('v1');
    expect(req.url).toBe('/streams');
    expect(next).toHaveBeenCalled();
  });

  it('should return 400 for unsupported version', () => {
    req = { path: '/v2/streams', url: '/v2/streams' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('should skip version extraction if path does not match vN pattern', () => {
    req = { path: '/health', url: '/health' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(req.apiVersion).toBeUndefined();
    expect(req.url).toBe('/health');
    expect(next).toHaveBeenCalled();
  });

  it('should preserve query strings when rewriting url', () => {
    req = { path: '/v1/streams', url: '/v1/streams?sender=G123' };
    apiVersionMiddleware(req as VersionedRequest, res as Response, next);
    expect(req.url).toBe('/streams?sender=G123');
    expect(next).toHaveBeenCalled();
  });

  it('should return default version if apiVersion is missing', () => {
    req = {};
    expect(getApiVersion(req as VersionedRequest)).toBe(DEFAULT_VERSION);
  });
});

describe('OpenAPI implementation parity', () => {
  const backendRoot = resolve(__dirname, '..');
  const specPath = resolve(backendRoot, 'swagger/flowfi.openapi.json');
  const scriptPath = resolve(backendRoot, 'scripts/export-openapi.ts');

  type Operation = {
    security?: unknown[];
    responses?: Record<string, unknown>;
    requestBody?: { content?: Record<string, unknown> };
  };
  type Spec = {
    openapi: string;
    paths: Record<string, Record<string, Operation>>;
    components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
  };

  const loadSpec = (): Spec => JSON.parse(readFileSync(specPath, 'utf8')) as Spec;

  const operations = (spec: Spec): Array<{ path: string; method: string; op: Operation }> =>
    Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([method]) => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(([method, op]) => ({ path, method, op: op as Operation })),
    );

  it('committed spec is reproducible from the export script (--check)', () => {
    expect(() =>
      execFileSync(process.execPath, ['--import', 'tsx', scriptPath, '--check'], {
        cwd: backendRoot,
        stdio: 'pipe',
      }),
    ).not.toThrow();
  });

  it('spec declares OpenAPI 3.x and a security scheme', () => {
    const spec = loadSpec();
    expect(spec.openapi).toMatch(/^3\./);
    expect(spec.components?.securitySchemes).toBeDefined();
    expect(Object.keys(spec.components?.securitySchemes ?? {}).length).toBeGreaterThan(0);
  });

  it('every documented path is versioned under /v1', () => {
    const spec = loadSpec();
    const paths = Object.keys(spec.paths);
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/v1/')).toBe(true);
    }
  });

  it('every operation documents responses including error status codes', () => {
    const spec = loadSpec();
    const ops = operations(spec);
    expect(ops.length).toBeGreaterThan(0);
    for (const { path, method, op } of ops) {
      const codes = Object.keys(op.responses ?? {});
      expect(codes.length, `${method.toUpperCase()} ${path} has no responses`).toBeGreaterThan(0);
      expect(codes.some((c) => c.startsWith('2')), `${method.toUpperCase()} ${path} missing 2xx`).toBe(true);
      expect(codes.some((c) => c.startsWith('4')), `${method.toUpperCase()} ${path} missing 4xx`).toBe(true);
    }
  });

  it('every operation declares an auth requirement', () => {
    const spec = loadSpec();
    for (const { path, method, op } of operations(spec)) {
      expect(Array.isArray(op.security), `${method.toUpperCase()} ${path} missing security`).toBe(true);
    }
  });

  it('request bodies and response schemas reference declared components', () => {
    const spec = loadSpec();
    const schemas = spec.components?.schemas ?? {};
    const refs: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(collect);
      } else if (node && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key === '$ref' && typeof value === 'string') refs.push(value);
          else collect(value);
        }
      }
    };
    collect(spec.paths);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      const match = /^#\/components\/schemas\/(.+)$/.exec(ref);
      if (match) {
        expect(schemas, `unresolved schema ref ${ref}`).toHaveProperty([match[1]]);
      }
    }
  });
});
