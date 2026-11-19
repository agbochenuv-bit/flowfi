import assert from "node:assert/strict";
import { test } from "node:test";
import { npmVersionChanges } from "./dependency-report.mjs";

test("reports an exact candidate update, added and removed packages, and ignores workspace metadata", () => {
  const before = { packages: {
    "": { version: "1.0.0" },
    "node_modules/example": { version: "1.2.0" },
    "node_modules/old": { version: "2.0.0" },
    "node_modules/same": { version: "3.0.0" },
  } };
  const after = { packages: {
    "": { version: "1.1.0" },
    "node_modules/example": { version: "1.2.1" },
    "node_modules/new": { version: "4.0.0" },
    "node_modules/same": { version: "3.0.0" },
  } };
  assert.deepEqual(npmVersionChanges(before, after), [
    "- `node_modules/example` 1.2.0 → 1.2.1",
    "- `node_modules/new` added → 4.0.0",
    "- `node_modules/old` 2.0.0 → removed",
  ]);
  assert.deepEqual(npmVersionChanges(before, before), []);
});
