import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const template = readFileSync(new URL("INCIDENT_REVIEW_TEMPLATE.md", import.meta.url), "utf8");

test("recovery and follow-up tables capture ownership and verification", () => {
  assert.match(template, /\| Mitigation or recovery action \| Owner \| Observed result \| Verification evidence or remaining uncertainty \|/);
  assert.match(template, /\| Follow-up \| Accountable owner \| Due date \(UTC\) \| Verification criteria \|/);
  assert.match(template, /Leave unknown values marked \*\*unknown\*\*/);
  assert.match(template, /Omit credentials, private keys, bearer tokens, raw request bodies, customer identifiers, and wallet addresses/);
});

test("every referenced policy and recovery runbook resolves locally", () => {
  const links = [...template.matchAll(/\]\(([^)]+\.md)\)/g)];
  assert.equal(links.length, 4);
  for (const [, link] of links) {
    assert.ok(readFileSync(new URL(link, import.meta.url), "utf8").trim(), `Empty runbook: ${link}`);
  }
});
