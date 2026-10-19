import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { resolve } from 'node:path';

const backendRoot = resolve(__dirname, '..');
const scriptPath = resolve(backendRoot, 'scripts/check-api-compatibility.ts');

/**
 * Minimal mock health server. Responds to GET /health with a configurable
 * JSON body and status code so the compatibility script's exit logic can be
 * exercised without hitting a real FlowFi backend.
 */
function startMockServer(port: number, body: unknown, statusCode = 200): Server {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

function runScript(env: Record<string, string>): { exitCode: number; stdout: string; stderr: string } {
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      ['--import', 'tsx', scriptPath],
      { cwd: backendRoot, stdio: 'pipe', env: { ...process.env, ...env } },
    ).toString('utf8');
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
    exitCode = e.status ?? 1;
    stdout = (typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString('utf8')) ?? '';
    stderr = (typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString('utf8')) ?? '';
  }
  return { exitCode, stdout, stderr };
}

describe('check-api-compatibility script', () => {
  let server: Server;
  let port: number;
  const baseUrl = () => `http://127.0.0.1:${port}`;

  beforeAll(() => {
    // Use a fixed high port; if it conflicts, pick a random one via listen(0).
    return new Promise<void>((resolveListen) => {
      server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        port = typeof addr === 'object' && addr ? addr.port : 0;
        server.close(resolveListen);
      });
    });
  });

  // Helper: (re)start the mock server on the discovered port with a given body.
  function withServer(body: unknown, statusCode = 200, fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolveRun, rejectRun) => {
      const srv = startMockServer(port, body, statusCode);
      fn()
        .then(() => {
          srv.close(() => resolveRun());
        })
        .catch((err) => {
          srv.close(() => rejectRun(err));
        });
    });
  }

  it('exits 0 when all required versions are present', async () => {
    const health = {
      status: 'ok',
      apiVersions: { supported: ['v1'], default: 'v1' },
    };
    await withServer(health, 200, async () => {
      const result = runScript({ API_URL: baseUrl(), REQUIRED_API_VERSIONS: 'v1' });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('PASSED');
    });
  });

  it('exits 1 when a required version is missing', async () => {
    const health = {
      status: 'ok',
      apiVersions: { supported: ['v2'], default: 'v2' },
    };
    await withServer(health, 200, async () => {
      const result = runScript({ API_URL: baseUrl(), REQUIRED_API_VERSIONS: 'v1' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('FAILED');
      expect(result.stderr).toContain('v1');
    });
  });

  it('exits 1 when apiVersions is empty/missing', async () => {
    const health = { status: 'ok' };
    await withServer(health, 200, async () => {
      const result = runScript({ API_URL: baseUrl(), REQUIRED_API_VERSIONS: 'v1' });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('FAILED');
    });
  });
});
