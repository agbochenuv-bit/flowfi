import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {},
}));

import {
  createPinnedWebhookLookup,
  isPublicWebhookAddress,
  resolveSafeWebhookTarget,
} from '../src/services/webhook.service.js';

describe('webhook destination protection', () => {
  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.20.1.2',
    '192.168.1.1',
    '198.51.100.8',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
    '2001:200::1',
    '2002::1',
  ])('blocks non-public address %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPublicWebhookAddress(address)).toBe(true);
  });

  it('accepts HTTPS only when every DNS answer is public', async () => {
    const resolver = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ]);

    const result = await resolveSafeWebhookTarget('https://hooks.example.test/events', resolver);

    expect(result.url.href).toBe('https://hooks.example.test/events');
    expect(result.addresses).toHaveLength(2);
    expect(resolver).toHaveBeenCalledWith('hooks.example.test');
  });

  it('pins socket DNS lookup to the complete validated address set', () => {
    const addresses = [
      { address: '8.8.8.8', family: 4 },
      { address: '2606:4700:4700::1111', family: 6 },
    ];
    const lookup = createPinnedWebhookLookup(addresses);
    const lookupAll = vi.fn();
    const lookupOne = vi.fn();

    lookup('hooks.example.test', { all: true }, lookupAll);
    lookup('hooks.example.test', { all: false }, lookupOne);

    expect(lookupAll).toHaveBeenCalledWith(null, addresses);
    expect(lookupOne).toHaveBeenCalledWith(null, addresses[0]!.address, addresses[0]!.family);
  });

  it('rejects mixed public and private DNS answers', async () => {
    await expect(resolveSafeWebhookTarget('https://hooks.example.test', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '169.254.169.254', family: 4 },
    ])).rejects.toThrow('public IP addresses');
  });

  it.each([
    'http://hooks.example.test',
    'ftp://hooks.example.test',
    'https://user:password@hooks.example.test',
    'https://hooks.example.test/path#fragment',
  ])('rejects unsafe webhook URL %s', async (target) => {
    await expect(resolveSafeWebhookTarget(target, async () => [
      { address: '8.8.8.8', family: 4 },
    ])).rejects.toThrow();
  });
});