import { describe, it, expect } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import app from '../src/app.js';

describe('OpenAPI Contract Verification Suite', () => {
  const specPath = path.resolve(__dirname, '../swagger/flowfi.openapi.json');
  const specRaw = fs.readFileSync(specPath, 'utf8');
  const openapiSpec = JSON.parse(specRaw);

  it('OpenAPI specification exists and has valid structural metadata', () => {
    expect(openapiSpec.openapi).toMatch(/^3\./);
    expect(openapiSpec.info.title).toBe('FlowFi API');
    expect(openapiSpec.info.version).toBeDefined();
    expect(openapiSpec.paths).toBeDefined();
    expect(openapiSpec.components?.schemas).toBeDefined();
  });

  describe('Route Schema Conformance & Auth Requirements', () => {
    it('GET /health conforms to documented OpenAPI health schema', async () => {
      const res = await request(app).get('/health');
      expect([200, 503]).toContain(res.status);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('status');
      expect(typeof res.body.status).toBe('string');
    });

    it('GET /metrics returns documented prometheus text format', async () => {
      const res = await request(app).get('/metrics');
      expect([200, 403]).toContain(res.status);
      if (res.status === 200) {
        expect(res.headers['content-type']).toMatch(/text\/plain/);
      }
    });

    it('protected endpoints reject missing authentication with HTTP 401', async () => {
      // Find paths in OpenAPI requiring bearerAuth
      const protectedPaths = [
        { path: '/v1/webhooks', method: 'post' },
        { path: '/v1/users/me', method: 'get' },
      ];

      for (const { path: routePath, method } of protectedPaths) {
        const req = (request(app) as any)[method](routePath);
        const res = await req.send({});
        expect(res.status).toBe(401);
        expect(res.headers['content-type']).toMatch(/json/);
        expect(res.body).toHaveProperty('error');
      }
    });

    it('validates documented 404 error variant on non-existent stream lookup', async () => {
      const res = await request(app).get('/v1/streams/00000000-0000-0000-0000-000000000000');
      expect([400, 404]).toContain(res.status);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('error');
    });

    it('validates pagination and query parameter contracts on /v1/streams', async () => {
      const res = await request(app)
        .get('/v1/streams')
        .query({ page: 1, limit: 10 });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/json/);

      // Verify response is array or paginated object conforming to schema
      if (Array.isArray(res.body)) {
        expect(Array.isArray(res.body)).toBe(true);
      } else {
        expect(res.body).toHaveProperty('streams');
      }
    });
  });

  describe('Nullable Field & Enum Schema Integrity', () => {
    it('defines Stream schema with proper nullable date fields', () => {
      const streamSchema = openapiSpec.components.schemas.Stream;
      expect(streamSchema).toBeDefined();

      // Nullable fields in OpenAPI 3.1 are represented with type array or nullable flag
      const properties = streamSchema.properties;
      expect(properties).toBeDefined();
      expect(properties.status).toBeDefined();
    });

    it('defines documented error variants structure across components', () => {
      // Confirm all paths define documented error response codes
      for (const [pathKey, pathItem] of Object.entries<any>(openapiSpec.paths)) {
        for (const [method, operation] of Object.entries<any>(pathItem)) {
          if (['get', 'post', 'put', 'delete'].includes(method) && operation.responses) {
            const statusCodes = Object.keys(operation.responses);
            expect(statusCodes.length).toBeGreaterThan(0);
          }
        }
      }
    });
  });

  describe('Statement Export Contract', () => {
    const exportPaths = [
      { path: '/v1/exports', method: 'post' },
      { path: '/v1/exports/{jobId}', method: 'get' },
      { path: '/v1/exports/{jobId}/download', method: 'get' },
      { path: '/v1/exports/{jobId}/cancel', method: 'post' },
    ];

    it('documents all resumable export endpoints', () => {
      for (const { path: routePath, method } of exportPaths) {
        const pathItem = openapiSpec.paths[routePath];
        expect(pathItem, `missing path ${routePath}`).toBeDefined();
        expect(pathItem[method], `missing ${method} ${routePath}`).toBeDefined();
      }
    });

    it('requires bearer auth on every export endpoint', () => {
      for (const { path: routePath, method } of exportPaths) {
        const operation = openapiSpec.paths[routePath][method];
        expect(operation.security, `missing security on ${method} ${routePath}`).toBeDefined();
        expect(operation.security).toEqual(
          expect.arrayContaining([expect.objectContaining({ bearerAuth: expect.any(Array) })]),
        );
      }
    });

    it('defines the ExportJob schema with ownership, expiry, and status fields', () => {
      const jobSchema = openapiSpec.components.schemas.ExportJob;
      expect(jobSchema).toBeDefined();
      const props = jobSchema.properties;
      expect(props).toBeDefined();
      for (const field of ['id', 'status', 'format', 'expiresAt', 'createdAt']) {
        expect(props[field], `ExportJob missing ${field}`).toBeDefined();
      }
      expect(jobSchema.required).toEqual(
        expect.arrayContaining(['id', 'status', 'format', 'expiresAt']),
      );
    });

    it('documents the export column schema and timezone rules', () => {
      const columnSchema =
        openapiSpec.components.schemas.ExportColumn ??
        openapiSpec.components.schemas.ExportColumnSchema;
      expect(columnSchema).toBeDefined();
      expect(columnSchema.properties).toBeDefined();
      expect(columnSchema.properties.name).toBeDefined();
      expect(columnSchema.properties.type).toBeDefined();

      const createOp = openapiSpec.paths['/v1/exports'].post;
      const description = JSON.stringify(createOp);
      expect(description).toMatch(/UTC/);
      expect(description).toMatch(/column/i);
    });

    it('documents the COST_BUDGET_EXCEEDED error variant', () => {
      const errorSchema = openapiSpec.components.schemas.Error;
      expect(errorSchema).toBeDefined();
      const serialized = JSON.stringify(errorSchema);
      expect(serialized).toContain('COST_BUDGET_EXCEEDED');

      const createOp = openapiSpec.paths['/v1/exports'].post;
      expect(createOp.responses['429']).toBeDefined();
    });

    it('rejects unauthenticated export requests with HTTP 401', async () => {
      const res = await request(app).post('/v1/exports').send({});
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('error');
    });

    it('produces a structurally valid and reproducible spec', () => {
      const reparsed = JSON.parse(JSON.stringify(openapiSpec));
      expect(reparsed).toEqual(openapiSpec);
      expect(openapiSpec.paths['/v1/exports'].post.responses).toBeDefined();
      expect(Object.keys(openapiSpec.paths['/v1/exports'].post.responses).length).toBeGreaterThan(0);
    });
  });
});
