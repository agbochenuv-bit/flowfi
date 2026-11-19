import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { verifyWebhook } from './verify-webhook.mjs';

const timestamp = 1700000000;
const secret = 'test-fixture-only';
const body = Buffer.from('{"eventType":"TEST_PING","data":{"message":"é"}}');
const hmac = createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
const header = `t=${timestamp},v1=${hmac}`;

test('accepts the exact bytes through the five-minute boundary', () => {
  for (const skew of [-300, 0, 300]) {
    assert.equal(verifyWebhook(body, header, secret, timestamp + skew), true);
  }
});

test('rejects timestamps outside the freshness window', () => {
  for (const skew of [-301, 301]) {
    assert.equal(verifyWebhook(body, header, secret, timestamp + skew), false);
  }
});

test('rejects modified bytes and a different secret', () => {
  assert.equal(verifyWebhook(Buffer.concat([body, Buffer.from('\n')]), header, secret, timestamp), false);
  assert.equal(verifyWebhook(body, header, 'wrong', timestamp), false);
});

test('rejects malformed and duplicate fields', () => {
  for (const invalid of [undefined, header + '\n', header + ',t=1700000000', 't=NaN,v1=' + hmac, 't=1700000000,v1=00']) {
    assert.equal(verifyWebhook(body, invalid, secret, timestamp), false);
  }
});
