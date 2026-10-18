/**
 * Export the OpenAPI spec to a committed JSON file so it can be consumed
 * without booting the API server (e.g. by `openapi-typescript` codegen and the
 * CI drift check).
 *
 *   npm run codegen:openapi          # write the spec
 *   npm run codegen:openapi -- --check   # verify committed spec is up to date
 *
 * The `--check` mode is what CI invokes to enforce OpenAPI implementation
 * parity: it regenerates the spec deterministically and compares it against
 * the committed `backend/swagger/flowfi.openapi.json`, exiting non-zero on any
 * drift (route, schema, status-code, or auth documentation changes).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { swaggerSpec } from '../src/config/swagger.js';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'swagger');
const outFile = join(outDir, 'flowfi.openapi.json');

const checkMode = process.argv.includes('--check');

/**
 * Recursively sort object keys so the serialized spec is byte-for-byte stable
 * across runs and machines. Arrays keep their order (order is meaningful for
 * e.g. `servers`, `tags`, and `parameters`).
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

function serializeSpec(): string {
  const sorted = sortKeysDeep(swaggerSpec);
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function main(): void {
  let serialized: string;
  try {
    serialized = serializeSpec();
  } catch (error) {
    console.error('Failed to generate OpenAPI spec:', error);
    process.exit(1);
  }

  if (checkMode) {
    let committed: string;
    try {
      committed = readFileSync(outFile, 'utf8');
    } catch (error) {
      console.error(
        `Unable to read committed OpenAPI spec at ${outFile}. ` +
          'Run `npm run codegen:openapi` to generate it.',
      );
      console.error(error);
      process.exit(1);
    }

    if (committed !== serialized) {
      console.error(
        `OpenAPI spec drift detected: committed ${outFile} does not match ` +
          'the generated spec. Run `npm run codegen:openapi` and commit the result.',
      );
      process.exit(1);
    }

    console.log(`OpenAPI spec is up to date (${outFile}).`);
    return;
  }

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, serialized);
  } catch (error) {
    console.error(`Failed to write OpenAPI spec to ${outFile}:`, error);
    process.exit(1);
  }
  console.log(`OpenAPI spec written to ${outFile}`);
}

main();