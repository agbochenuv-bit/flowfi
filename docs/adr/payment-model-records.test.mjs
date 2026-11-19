import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

for (const record of ["0007-organization-ownership.md", "0008-recurring-payment-execution.md"]) {
  test(`${record} is indexed as a proposal and gates changes on both owners`, () => {
    const indexRow = read("README.md").split("\n").find((line) => line.includes(`(${record})`));
    assert.match(indexRow ?? "", /\| Proposed \|$/);
    const document = read(record);
    assert.match(document, /## Status\s+Proposed\. Contract and backend owners must both approve before implementation\./);
    assert.match(document, /## Alternatives considered/);
    assert.match(document, /## Consequences and migration/);
    for (const [, link] of document.matchAll(/\]\(([^)]+\.md)\)/g)) {
      assert.ok(read(link).length > 0, `Empty referenced document: ${link}`);
    }
  });
}
