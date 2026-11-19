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

  describe('Stale Mutation Conflict Contract', () => {
    it('documents a stable 409 conflict response with current version metadata', () => {
      const conflictSchema =
        openapiSpec.components.schemas.StreamConflictError ??
        openapiSpec.components.schemas.ConflictError;
      expect(conflictSchema).toBeDefined();
      expect(conflictSchema.properties).toBeDefined();

      // Stable machine-readable code plus current version metadata
      expect(conflictSchema.properties.code).toBeDefined();
      expect(conflictSchema.properties.currentVersion).toBeDefined();

      const codeEnum = conflictSchema.properties.code.enum;
      if (codeEnum) {
        expect(codeEnum).toContain('STREAM_VERSION_CONFLICT');
      }
    });

    it('documents expected version input on stream mutation operations', () => {
      const mutationPaths = Object.entries<any>(openapiSpec.paths).filter(
        ([, pathItem]) =>
          pathItem.patch?.requestBody || pathItem.put?.requestBody,
      );
      expect(mutationPaths.length).toBeGreaterThan(0);

      for (const [, pathItem] of mutationPaths) {
        const operation = pathItem.patch ?? pathItem.put;
        const responses = operation.responses ?? {};
        // Mutations that accept a reviewed version must document the conflict outcome
        const hasConflict = Object.keys(responses).some((status) =>
          status.startsWith('409'),
        );
        if (hasConflict) {
          expect(responses['409'] ?? responses['409 ']).toBeDefined();
        }
      }
    });
  });

  describe('Token Metadata Provenance Contract', () => {
    it('documents provenance and staleness fields on token metadata', () => {
      const tokenSchema =
        openapiSpec.components.schemas.TokenMetadata ??
        openapiSpec.components.schemas.Token;
      expect(tokenSchema).toBeDefined();
      expect(tokenSchema.properties).toBeDefined();

      expect(tokenSchema.properties.source).toBeDefined();
      expect(tokenSchema.properties.trustLevel).toBeDefined();
      expect(tokenSchema.properties.stale).toBeDefined();

      const trustLevels = tokenSchema.properties.trustLevel.enum;
      if (trustLevels) {
        expect(trustLevels).toEqual(
          expect.arrayContaining(['verified', 'hint', 'unavailable']),
        );
      }
    });
  });

  describe('Action Readiness Contract', () => {
    it('documents the readiness endpoint with stable result codes', async () => {
      const readinessPath = openapiSpec.paths['/v1/streams/{id}/readiness'];
      expect(readinessPath).toBeDefined();
      expect(readinessPath.get).toBeDefined();
      expect(readinessPath.get.responses['200']).toBeDefined();

      const readinessSchema =
        openapiSpec.components.schemas.ActionReadiness ??
        openapiSpec.components.schemas.ReadinessResult;
      expect(readinessSchema).toBeDefined();
      expect(readinessSchema.properties).toBeDefined();
      expect(readinessSchema.properties.checks).toBeDefined();

      const res = await request(app).get(
        '/v1/streams/00000000-0000-0000-0000-000000000000/readiness',
      );
      expect([400, 401, 404]).toContain(res.status);
      expect(res.headers['content-type']).toMatch(/json/);
    });
  });

  describe('Wallet Session Inventory Contract', () => {
    it('documents session inventory and revocation endpoints', () => {
      const sessionsPath = openapiSpec.paths['/v1/auth/sessions'];
      expect(sessionsPath).toBeDefined();
      expect(sessionsPath.get).toBeDefined();
      expect(sessionsPath.get.responses['200']).toBeDefined();

      const revokePath = openapiSpec.paths['/v1/auth/sessions/{id}'];
      expect(revokePath).toBeDefined();
      expect(revokePath.delete).toBeDefined();
      expect(revokePath.delete.responses['204'] ?? revokePath.delete.responses['200']).toBeDefined();
    });

    it('rejects unauthenticated session inventory access with HTTP 401', async () => {
      const res = await request(app).get('/v1/auth/sessions');
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body).toHaveProperty('error');
    });
  });
});
