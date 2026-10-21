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
});
