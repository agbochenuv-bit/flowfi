# API Collections

## Authorization test inventory

`backend/tests/authorization-matrix.test.ts` lists every registered v1 route
with its public, wallet, or platform-admin expectation. Adding a route or route
file requires adding an explicit expectation before the test passes. The same
suite confirms that a role claim in a JWT never overrides a personal stream's
wallet owner; `backend/tests/webhook-authorization-matrix.test.ts` checks the
same isolation for webhook listings, deliveries, secret rotation, and deletion.
Organization memberships and their resource routes are not present in this API
yet, so these tests do not confer organization access or replace the wallet's
on-chain signing authority.

This directory contains hand-maintained Postman/Hoppscotch collections for exploring the FlowFi API.

**Source of truth:** [`backend/src/config/swagger.ts`](../../backend/src/config/swagger.ts) and the `@openapi` JSDoc annotations on each route. The generated spec is served live at `http://localhost:3001/api-docs` (UI) and `http://localhost:3001/api-docs.json` (raw OpenAPI JSON).

`flowfi.postman_collection.json` and `flowfi.hoppscotch_collection.json` are convenience collections for manual testing — they are not generated from the OpenAPI spec and can drift. When routes change:

1. Update the `@openapi` annotations on the affected route/controller first.
2. Re-check the endpoints in this directory's collections against `http://localhost:3001/api-docs.json` and update paths, methods, and bodies to match.
3. If a collection and the Swagger spec ever disagree, the Swagger spec wins.

See the [financial glossary](../ux/FINANCIAL_GLOSSARY.md) for amount sources, freshness, and transaction status terminology.

## Feature Specifications

- [Organizations API](./ORGANIZATIONS.md) — Wallet-linked organization membership, role/action matrix, treasury summary, and multi-network scoping.
- [Stream Reads, Search, Chain Freshness, and Wallet-Scoped API Credentials](./STREAMS_READ_AND_CREDENTIALS.md) — Bounded multi-stream reads (#229), normalized search/filter semantics (#230), chain freshness & finality metadata (#231), and wallet-scoped API credentials (#232).
