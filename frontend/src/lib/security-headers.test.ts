import { describe, it, expect } from 'vitest';
import { buildCspDirectives, getSecurityHeaders } from './security-headers';

describe('Security Headers & CSP Builder', () => {
  it('should include core CSP directives in production mode', () => {
    const csp = buildCspDirectives({ isDev: false, isPreview: false });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).not.toContain("'unsafe-eval'");
  });

  it('should include unsafe-eval only in development mode', () => {
    const devCsp = buildCspDirectives({ isDev: true });
    expect(devCsp).toContain("'unsafe-eval'");
    expect(devCsp).not.toContain('upgrade-insecure-requests');

    const prodCsp = buildCspDirectives({ isDev: false });
    expect(prodCsp).not.toContain("'unsafe-eval'");
  });

  it('should permit wallet extension protocols and known wallet frames', () => {
    const csp = buildCspDirectives();
    expect(csp).toContain('chrome-extension:');
    expect(csp).toContain('moz-extension:');
    expect(csp).toContain('https://albedo.link');
    expect(csp).toContain('https://verify.walletconnect.com');
  });

  it('should include configured API and SSE origins in connect-src', () => {
    const csp = buildCspDirectives({
      apiUrl: 'https://api.flowfi.example.com',
      sseUrl: 'https://sse.flowfi.example.com',
    });

    expect(csp).toContain('https://api.flowfi.example.com');
    expect(csp).toContain('https://sse.flowfi.example.com');
  });

  it('should permit vercel preview origins in preview mode', () => {
    const previewCsp = buildCspDirectives({ isDev: false, isPreview: true });
    expect(previewCsp).toContain('https://*.vercel.app');

    const prodCsp = buildCspDirectives({ isDev: false, isPreview: false });
    expect(prodCsp).not.toContain('https://*.vercel.app');
  });

  it('should return complete standard security headers', () => {
    const headers = getSecurityHeaders({ isDev: false });
    const headerMap = Object.fromEntries(headers.map((h) => [h.key, h.value]));

    expect(headerMap['X-Frame-Options']).toBe('DENY');
    expect(headerMap['X-Content-Type-Options']).toBe('nosniff');
    expect(headerMap['Referrer-Policy']).toBe('strict-origin-when-cross-origin');
    expect(headerMap['Permissions-Policy']).toContain('camera=()');
    expect(headerMap['Strict-Transport-Security']).toContain('max-age=63072000');
    expect(headerMap['Content-Security-Policy']).toBeDefined();
  });
});
