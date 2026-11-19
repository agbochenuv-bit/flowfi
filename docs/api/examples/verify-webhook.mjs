import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyWebhook(body, header, secret, now = Math.floor(Date.now() / 1000)) {
  if (!Buffer.isBuffer(body) || typeof header !== 'string' || !secret) return false;
  const match = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!match || match[0] !== header) return false;

  const [, timestamp, signature] = match;
  if (Math.abs(now - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(timestamp).update('.').update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
