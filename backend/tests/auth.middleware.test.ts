import { Request, Response, NextFunction } from 'express';
import { authMiddleware, AuthenticatedRequest } from '../src/middleware/auth.middleware';
import { sessionStore } from '../src/services/session.store';

describe('authMiddleware', () => {
  let req: Partial<AuthenticatedRequest>;
  let res: Partial<Response>;
  let next: NextFunction;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;

  beforeEach(() => {
    jest.restoreAllMocks();
    sessionStore.clear();

    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    req = {
      headers: {},
      cookies: {},
    };

    res = {
      status: statusMock,
      json: jsonMock,
    } as unknown as Partial<Response>;

    next = jest.fn();
  });

  afterEach(() => {
    sessionStore.clear();
  });

  function makeRequestWithSession(sessionId: string, walletAddress = '0xabc'): Partial<AuthenticatedRequest> {
    return {
      headers: {
        authorization: `Bearer ${sessionId}`,
      },
      cookies: {},
      walletAddress,
    } as unknown as Partial<AuthenticatedRequest>;
  }

  it('propagates the session id onto the authenticated request', () => {
    const session = sessionStore.createSession('0xabc');

    req = makeRequestWithSession(session.id);

    authMiddleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith();
    expect(statusMock).not.toHaveBeenCalled();
    expect((req as AuthenticatedRequest).sessionId).toBe(session.id);
    expect((req as AuthenticatedRequest).walletAddress).toBe('0xabc');
  });

  it('rejects a revoked session with 401', () => {
    const session = sessionStore.createSession('0xabc');
    sessionStore.revokeSession(session.id);

    req = makeRequestWithSession(session.id);

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
    expect((req as AuthenticatedRequest).sessionId).toBeUndefined();
  });

  it('rejects an expired session with 401', () => {
    const session = sessionStore.createSession('0xabc');

    // Simulate expiry by advancing time past the session TTL.
    const nowSpy = jest.spyOn(Date, 'now');
    nowSpy.mockReturnValue(session.expiresAt + 1);

    req = makeRequestWithSession(session.id);

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
    expect((req as AuthenticatedRequest).sessionId).toBeUndefined();

    nowSpy.mockRestore();
  });

  it('rejects an unknown session id with 401', () => {
    req = makeRequestWithSession('nonexistent-session-id');

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('rejects a request with no session credentials with 401', () => {
    req = { headers: {}, cookies: {} } as Partial<AuthenticatedRequest>;

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
  });

  it('rejects a session whose wallet address does not match the request', () => {
    const session = sessionStore.createSession('0xabc');

    req = makeRequestWithSession(session.id, '0xdef');

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(401);
    expect((req as AuthenticatedRequest).sessionId).toBeUndefined();
  });

  it('does not propagate a session id when the session is revoked mid-request lifecycle', () => {
    const session = sessionStore.createSession('0xabc');
    sessionStore.revokeSession(session.id);

    req = makeRequestWithSession(session.id);

    authMiddleware(req as Request, res as Response, next);

    expect(next).not.toHaveBeenCalled();
    expect((req as AuthenticatedRequest).sessionId).toBeUndefined();
    expect(statusMock).toHaveBeenCalledWith(401);
  });
});