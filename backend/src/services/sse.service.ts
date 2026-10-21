import { randomUUID } from 'crypto';
import type { Response } from 'express';
import logger, { requestContext } from '../logger.js';
import { isRedisAvailable, getPublisher, getSubscriber } from '../lib/redis.js';
import {
  sseClientsDroppedTotal,
  sseConnectionsTotal,
  sseMaxConnections,
  setSseConnectionCounts,
  sseSlowConsumerQueueDepth,
  sseReplayBufferSize,
  sseRedisReconnectsTotal,
  sseEventDeduplicatesTotal,
} from '../lib/metrics.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_WRITABLE_BUFFER = 64 * 1024;
const MAX_CONNECTIONS_PER_IP = 5;
const MAX_CONNECTIONS_PER_USER = 10;
const RETRY_AFTER_SECONDS = 60;

// ─── Issue 1: Replay window ───────────────────────────────────────────────────
// In-process ring buffer for recent events. Each entry carries a stable numeric
// ID (monotonically incrementing per-process), the channel it was published on,
// and the serialised message. On reconnect the client sends `Last-Event-ID`; we
// replay every entry whose ID is greater than that value, bounded by
// SSE_REPLAY_WINDOW_SIZE entries and SSE_REPLAY_MAX_AGE_MS milliseconds.
//
// This is intentionally per-process (not Redis-backed). In a multi-instance
// deployment a reconnecting client may land on a different process; the browser
// will still receive the events that instance has seen. Full cross-instance
// replay would require storing events in Redis or the DB and is out of scope
// for this fix — the replay buffer is a best-effort catch-up layer.

const SSE_REPLAY_WINDOW_SIZE = (() => {
  const v = Number.parseInt(process.env.SSE_REPLAY_WINDOW_SIZE ?? '200', 10);
  return Number.isFinite(v) && v > 0 ? v : 200;
})();

const SSE_REPLAY_MAX_AGE_MS = (() => {
  const v = Number.parseInt(process.env.SSE_REPLAY_MAX_AGE_MS ?? '60000', 10);
  return Number.isFinite(v) && v > 0 ? v : 60_000; // default 60 s
})();

// ─── Issue 3: Per-client queue depth ─────────────────────────────────────────
// Before writing to a paused client we enqueue the message.  If the in-memory
// queue for that client grows beyond MAX_CLIENT_QUEUE_DEPTH we disconnect it
// rather than accumulating unbounded memory.

const DEFAULT_MAX_CLIENT_QUEUE_DEPTH = (() => {
  const v = Number.parseInt(process.env.SSE_MAX_CLIENT_QUEUE_DEPTH ?? '100', 10);
  return Number.isFinite(v) && v > 0 ? v : 100;
})();

// ─── Issue 4: Redis deduplication window ─────────────────────────────────────
// We keep a small in-process LRU set of recently seen event IDs (from Redis
// pub/sub). If the same payload is delivered twice (e.g. after a reconnect to
// the broker) we drop the duplicate before fanning out to local clients.

const DEDUP_WINDOW_SIZE = 500;

interface ReplayEntry {
  /** Stable monotonic numeric ID used as SSE `id:` field. */
  id: number;
  /** The fully-formatted SSE message string (ready to write). */
  message: string;
  /** Wall-clock time this entry was recorded. Used for age-based eviction. */
  recordedAt: number;
  /** The subscription channel this event belongs to (stream ID or `user:KEY`). */
  channel: string;
}

interface SSEClient {
  id: string;
  res: Response;
  subscriptions: Set<string>;
  paused: boolean;
  ip: string;
  userId?: string;
  /** Issue 3: per-client overflow queue drained on backpressure release. */
  queue: string[];
  /** Wall-clock time the connection was established (for auth revalidation). */
  connectedAt: number;
  /** The SSE Last-Event-ID supplied at connect time, for replay tracking. */
  lastEventId: number | null;
  /** Issue 2: wall-clock time the auth was last revalidated. */
  lastAuthCheck: number;
  /** Issue 2: the public key this connection was authenticated as. */
  authPublicKey: string;
  /** Issue 2: whether the connection has been invalidated and is pending close. */
  authRevoked: boolean;
}

interface SSECapacityCheckResult {
  allowed: boolean;
  status?: number;
  retryAfterSeconds?: number;
  message?: string;
}

/** An SSE message payload as it travels through the Redis pub/sub channel. */
interface SSERedisMessage {
  /** Application-level event name (e.g. "stream.updated"). */
  event: string;
  /** Event data. */
  data: unknown;
  /**
   * Issue 4: stable logical identity for this event.
   * For DB-backed events this should be the `StreamEvent.id` UUID so
   * transport retries cannot double-apply the same update. For synthetic
   * events (heartbeats, admin broadcasts) a randomUUID() is fine.
   */
  eventId: string;
}

export class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private slowClientsDropped = 0;
  private readonly ipConnectionCounts: Map<string, number> = new Map();
  private readonly userConnectionCounts: Map<string, number> = new Map();
  private shuttingDown = false;
  private perIpPeakConnections = 0;
  private perUserPeakConnections = 0;

  // Issue 1: replay ring buffer
  private replayBuffer: ReplayEntry[] = [];
  private replaySeq = 0;

  // Issue 4: deduplication LRU set
  private readonly seenEventIds: string[] = [];

  // Issue 4: Redis reconnect state
  private redisReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private redisSubscribed = false;

  // Issue 2: periodic auth revalidation timer
  private authCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly AUTH_CHECK_INTERVAL_MS = 60_000; // 1 min
  AUTH_MAX_CONN_AGE_MS = (() => {
    const v = Number.parseInt(process.env.SSE_MAX_CONN_AGE_MS ?? '3600000', 10);
    return Number.isFinite(v) && v > 0 ? v : 3_600_000; // 1 hour
  })();

  // Issue 3: per-client queue overflow depth — exposed for test override
  maxClientQueueDepth: number = DEFAULT_MAX_CLIENT_QUEUE_DEPTH;

  /**
   * Stable id attached to every log line emitted by the heartbeat
   * setInterval callback, since it fires outside of any HTTP request and
   * would otherwise have no requestContext (and thus no correlation id).
   */
  private readonly heartbeatWorkerId = `sse-heartbeat:${randomUUID()}`;

  private readonly maxConnections: number = (() => {
    const parsed = Number.parseInt(process.env.MAX_SSE_CONNECTIONS ?? '10000', 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return 10000;
    return parsed;
  })();

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  // ─── Issue 4: Redis reconnect logic ────────────────────────────────────────

  /**
   * Subscribe to the Redis SSE patterns. Automatically re-subscribes after
   * the connection drops (detected via the `error` and `close`/`end` events
   * on the subscriber client). On reconnect we use an exponential back-off
   * capped at 30 s to avoid thundering-herd pressure on the broker.
   */
  async initRedisSubscription(attempt = 0): Promise<void> {
    const sub = getSubscriber();
    if (!sub) {
      // Redis not configured — single-instance mode.
      return;
    }

    // Prevent double-subscription on manual re-calls.
    if (this.redisSubscribed) return;

    try {
      await sub.psubscribe('sse:stream:*', 'sse:user:*');
      this.redisSubscribed = true;
      logger.info('[SSEService] Redis pub/sub subscription active.');

      // Issue 4: handle incoming messages with deduplication.
      sub.on('pmessage', (_pattern: string, channel: string, rawMessage: string) => {
        this._handleRedisMessage(channel, rawMessage);
      });

      // Reconnect on transient errors.
      sub.once('error', (err: Error) => {
        this.redisSubscribed = false;
        logger.warn('[SSEService] Redis subscriber error — will reconnect:', err.message);
        this._scheduleRedisReconnect(0);
      });

      // ioredis emits 'close' when the TCP connection drops.
      sub.once('close', () => {
        if (this.redisSubscribed) {
          this.redisSubscribed = false;
          logger.warn('[SSEService] Redis subscriber closed — will reconnect.');
          this._scheduleRedisReconnect(0);
        }
      });

      // Track successful (re)connections in metrics.
      if (attempt > 0) {
        sseRedisReconnectsTotal.inc({ outcome: 'success' });
      }
    } catch (err) {
      this.redisSubscribed = false;
      logger.warn(`[SSEService] Redis subscription attempt ${attempt + 1} failed:`, err);
      sseRedisReconnectsTotal.inc({ outcome: 'failure' });
      this._scheduleRedisReconnect(attempt);
    }
  }

  private _scheduleRedisReconnect(priorAttempt: number): void {
    if (this.shuttingDown) return;
    if (this.redisReconnectTimer) return; // already scheduled

    // Exponential back-off: 1s, 2s, 4s … capped at 30s.
    const delayMs = Math.min(1000 * 2 ** priorAttempt, 30_000);
    logger.info(`[SSEService] Redis reconnect scheduled in ${delayMs}ms (attempt ${priorAttempt + 1}).`);

    this.redisReconnectTimer = setTimeout(async () => {
      this.redisReconnectTimer = null;
      if (!this.shuttingDown && isRedisAvailable()) {
        await this.initRedisSubscription(priorAttempt + 1);
      }
    }, delayMs);
  }

  /**
   * Issue 4: process a raw Redis pub/sub message.
   *
   * 1. Parse the JSON envelope.
   * 2. Check `eventId` against the deduplication window.  If already seen,
   *    increment the metric and return without fanning out.
   * 3. Record the ID in the dedup LRU set.
   * 4. Fan out to local clients.
   */
  private _handleRedisMessage(channel: string, rawMessage: string): void {
    let parsed: SSERedisMessage;
    try {
      parsed = JSON.parse(rawMessage) as SSERedisMessage;
    } catch (err) {
      logger.warn('[Redis SSE] Failed to parse pub/sub message:', err);
      return;
    }

    const { event, data, eventId } = parsed;

    // Deduplication
    if (eventId) {
      if (this.seenEventIds.includes(eventId)) {
        sseEventDeduplicatesTotal.inc();
        return;
      }
      // LRU eviction: drop the oldest entry when at capacity.
      if (this.seenEventIds.length >= DEDUP_WINDOW_SIZE) {
        this.seenEventIds.shift();
      }
      this.seenEventIds.push(eventId);
    }

    if (channel.startsWith('sse:stream:')) {
      this._localBroadcastToStream(channel.slice('sse:stream:'.length), event, data, eventId);
    } else if (channel.startsWith('sse:user:')) {
      this._localBroadcastToUser(channel.slice('sse:user:'.length), event, data, eventId);
    }
  }

  // ─── Issue 4: Redis health check ───────────────────────────────────────────

  /**
   * Returns true if the SSE Redis subscription is currently active.
   * Useful for health endpoints.
   */
  isRedisSubscribed(): boolean {
    return this.redisSubscribed;
  }

  // ─── Capacity check ────────────────────────────────────────────────────────

  checkCapacity(ip: string, userId?: string): SSECapacityCheckResult {
    if (this.clients.size >= this.maxConnections) {
      sseClientsDroppedTotal.inc({ reason: 'capacity' });
      return {
        allowed: false,
        status: 503,
        message: 'SSE capacity reached. Please try again shortly.',
      };
    }

    const currentIpConnections = this.ipConnectionCounts.get(ip) ?? 0;
    if (currentIpConnections >= MAX_CONNECTIONS_PER_IP) {
      sseClientsDroppedTotal.inc({ reason: 'per_ip_limit' });
      return {
        allowed: false,
        status: 429,
        retryAfterSeconds: RETRY_AFTER_SECONDS,
        message: `Too many SSE connections from this IP. Max ${MAX_CONNECTIONS_PER_IP}.`,
      };
    }

    if (userId) {
      const currentUserConnections = this.userConnectionCounts.get(userId) ?? 0;
      if (currentUserConnections >= MAX_CONNECTIONS_PER_USER) {
        return {
          allowed: false,
          status: 429,
          retryAfterSeconds: RETRY_AFTER_SECONDS,
          message: `Too many concurrent SSE connections for this user. Max ${MAX_CONNECTIONS_PER_USER}.`,
        };
      }
    }

    return { allowed: true };
  }

  // ─── Issue 1: replay on connect ────────────────────────────────────────────

  /**
   * Replay events from the ring buffer that:
   *  - occurred after `lastEventId` (numeric), AND
   *  - are within the configured age window, AND
   *  - belong to at least one of the client's subscribed channels.
   *
   * The replay is sent synchronously before the first live event; the
   * client will see events in the same order they were originally sent.
   */
  private _replayMissedEvents(client: SSEClient): void {
    if (client.lastEventId === null) return;

    const now = Date.now();
    const missed = this.replayBuffer.filter(
      (e) =>
        e.id > (client.lastEventId as number) &&
        now - e.recordedAt <= SSE_REPLAY_MAX_AGE_MS &&
        (client.subscriptions.has(e.channel) || client.subscriptions.has('*')),
    );

    if (missed.length === 0) return;

    logger.info(
      `[SSEService] Replaying ${missed.length} event(s) to reconnected client ${client.id}`,
    );

    for (const entry of missed) {
      this._rawWrite(client, entry.message);
    }
  }

  /**
   * Append a message to the replay ring buffer, evicting the oldest entry
   * when the window is full or entries exceed the max-age threshold.
   */
  private _recordToReplayBuffer(channel: string, message: string): number {
    const now = Date.now();

    // Evict stale entries.
    const cutoff = now - SSE_REPLAY_MAX_AGE_MS;
    while (this.replayBuffer.length > 0 && (this.replayBuffer[0]!.recordedAt < cutoff || this.replayBuffer.length >= SSE_REPLAY_WINDOW_SIZE)) {
      this.replayBuffer.shift();
    }

    const id = ++this.replaySeq;
    this.replayBuffer.push({ id, message, recordedAt: now, channel });

    // Publish the current buffer size as a gauge.
    sseReplayBufferSize.set(this.replayBuffer.length);

    return id;
  }

  // ─── Client lifecycle ──────────────────────────────────────────────────────

  addClient(
    clientId: string,
    res: Response,
    subscriptions: string[] = [],
    ip = 'unknown',
    userId?: string,
    lastEventId: number | null = null,
  ): void {
    const nextIpCount = (this.ipConnectionCounts.get(ip) ?? 0) + 1;
    this.ipConnectionCounts.set(ip, nextIpCount);
    this.perIpPeakConnections = Math.max(this.perIpPeakConnections, nextIpCount);

    if (userId) {
      const nextUserCount = (this.userConnectionCounts.get(userId) ?? 0) + 1;
      this.userConnectionCounts.set(userId, nextUserCount);
      this.perUserPeakConnections = Math.max(this.perUserPeakConnections, nextUserCount);
    }

    const now = Date.now();
    const client: SSEClient = {
      id: clientId,
      res,
      subscriptions: new Set(subscriptions),
      paused: false,
      ip,
      queue: [],
      connectedAt: now,
      lastEventId,
      lastAuthCheck: now,
      authPublicKey: userId ?? '',
      authRevoked: false,
      ...(userId !== undefined && { userId }),
    };

    this.clients.set(clientId, client);
    sseConnectionsTotal.inc();
    this.publishConnectionMetrics();
    logger.info(
      `[SSEService] Connection opened: ${clientId}, ip: ${ip}, userId: ${userId ?? 'n/a'}, subscriptions: ${subscriptions.join(', ')}, lastEventId: ${lastEventId ?? 'none'}`,
    );

    res.on('close', () => {
      this.removeClient(clientId);
    });

    // Issue 1: replay missed events if client supplied a Last-Event-ID.
    if (lastEventId !== null) {
      this._replayMissedEvents(client);
    }

    this.ensureHeartbeat();
    this.ensureAuthCheck();
  }

  // ─── Issue 2: periodic auth revalidation ───────────────────────────────────

  /**
   * Start the periodic auth-check interval if it isn't already running.
   * Every AUTH_CHECK_INTERVAL_MS we scan all live connections and:
   *  - disconnect any whose wall-clock age exceeds AUTH_MAX_CONN_AGE_MS
   *    (the JWT max-age; client must re-ticket and reconnect), OR
   *  - disconnect any that have been explicitly revoked (e.g. account deleted).
   *
   * This bounds how long a compromised or expired credential can hold an
   * open SSE connection even without a TCP reset.
   */
  private ensureAuthCheck(): void {
    if (this.authCheckTimer) return;

    this.authCheckTimer = setInterval(() => {
      requestContext.run({ requestId: this.heartbeatWorkerId }, () => {
        this._revalidateConnections();
      });
    }, this.AUTH_CHECK_INTERVAL_MS);
  }

  stopAuthCheck(): void {
    if (this.authCheckTimer) {
      clearInterval(this.authCheckTimer);
      this.authCheckTimer = null;
    }
  }

  /**
   * Scan all live connections and evict those whose credentials have expired.
   * Expired connections receive a `reconnect` event before being closed so
   * the browser retries with a fresh ticket.
   */
  private _revalidateConnections(): void {
    const now = Date.now();
    const toEvict: string[] = [];

    for (const client of this.clients.values()) {
      if (client.authRevoked) {
        toEvict.push(client.id);
        continue;
      }

      const age = now - client.connectedAt;
      if (age > this.AUTH_MAX_CONN_AGE_MS) {
        toEvict.push(client.id);
      }
    }

    for (const id of toEvict) {
      const client = this.clients.get(id);
      if (client) {
        // Send a reconnect event so the browser knows to re-authenticate.
        try {
          client.res.write('event: reconnect\ndata: {"reason":"auth_expired"}\n\n');
        } catch {
          // ignore — we're about to close anyway
        }
        sseClientsDroppedTotal.inc({ reason: 'auth_expired' });
        this.removeClient(id, 'auth_expired');
      }
    }

    if (toEvict.length > 0) {
      logger.info(`[SSEService] Evicted ${toEvict.length} connection(s) due to auth expiry.`);
    }
  }

  /**
   * Issue 2: forcibly revoke all connections for a given user.
   * Call this after a token is invalidated (e.g. detected compromise) or
   * the user's account is suspended.
   */
  revokeUserConnections(publicKey: string): void {
    let count = 0;
    for (const client of this.clients.values()) {
      if (client.authPublicKey === publicKey) {
        client.authRevoked = true;
        count++;
      }
    }
    if (count > 0) {
      // Evict on the next revalidation sweep (within AUTH_CHECK_INTERVAL_MS).
      logger.info(`[SSEService] Revoked ${count} connection(s) for user ${publicKey}.`);
    }
  }

  // ─── Metrics helpers ────────────────────────────────────────────────────────

  /**
   * Re-derive the per-topic connection gauges from the live client map.
   */
  private publishConnectionMetrics(): void {
    const countsByTopic = new Map<string, number>();
    for (const client of this.clients.values()) {
      for (const topic of client.subscriptions) {
        countsByTopic.set(topic, (countsByTopic.get(topic) ?? 0) + 1);
      }
    }

    setSseConnectionCounts(countsByTopic, this.clients.size);
  }

  /**
   * Issue 3: update the slow-consumer queue depth gauge by summing every
   * live client's pending queue length.
   */
  private publishQueueDepthMetrics(): void {
    let total = 0;
    for (const client of this.clients.values()) {
      total += client.queue.length;
    }
    sseSlowConsumerQueueDepth.set(total);
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────────────

  sendHeartbeat(): void {
    const message = ': heartbeat\n\n';
    for (const client of this.clients.values()) {
      this.writeToClient(client, message);
    }
  }

  sendReconnectToAll(): void {
    this.shuttingDown = true;
    const message = 'event: reconnect\ndata: {}\n\n';
    for (const client of this.clients.values()) {
      try {
        client.res.write(message);
      } catch {
        // ignore write errors during shutdown
      }
    }
    logger.info(`[SSEService] Sent reconnect to ${this.clients.size} client(s).`);
  }

  // ─── Broadcast helpers ──────────────────────────────────────────────────────

  /**
   * Build a fully-formatted SSE message string with:
   *  - `id:` field (stable numeric sequence from the replay buffer), OR
   *    explicit eventId if provided.
   *  - `event:` field
   *  - `data:` field
   *
   * The `id:` field lets the browser set `Last-Event-ID` automatically so
   * the next reconnect carries the sequence number without any client code.
   */
  private _formatMessage(
    event: string,
    data: unknown,
    channel: string,
    explicitEventId?: string,
  ): { message: string; seq: number } {
    // Record into replay buffer first to get the stable sequence number.
    const rawBody = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const seq = this._recordToReplayBuffer(channel, rawBody);
    // Prepend the `id:` field so the browser tracks Last-Event-ID.
    const message = `id: ${seq}\n${rawBody}`;
    return { message, seq };
  }

  broadcast(event: string, data: unknown, filter?: (client: SSEClient) => boolean): void {
    const { message } = this._formatMessage(event, data, '*');
    for (const client of this.clients.values()) {
      if (!filter || filter(client)) {
        this.writeToClient(client, message);
      }
    }
  }

  broadcastToStream(streamId: string, event: string, data: unknown, eventId?: string): void {
    if (isRedisAvailable()) {
      const payload: SSERedisMessage = {
        event,
        data,
        eventId: eventId ?? randomUUID(),
      };
      getPublisher()?.publish(`sse:stream:${streamId}`, JSON.stringify(payload));
    } else {
      this._localBroadcastToStream(streamId, event, data, eventId);
    }
  }

  broadcastToUser(publicKey: string, event: string, data: unknown, eventId?: string): void {
    if (isRedisAvailable()) {
      const payload: SSERedisMessage = {
        event,
        data,
        eventId: eventId ?? randomUUID(),
      };
      getPublisher()?.publish(`sse:user:${publicKey}`, JSON.stringify(payload));
    } else {
      this._localBroadcastToUser(publicKey, event, data, eventId);
    }
  }

  broadcastToAdmin(event: string, data: unknown, eventId?: string): void {
    const adminKey = process.env.ADMIN_PUBLIC_KEY;
    if (adminKey) {
      this.broadcastToUser(adminKey, event, data, eventId ?? randomUUID());
    }
  }

  private _localBroadcastToStream(streamId: string, event: string, data: unknown, eventId?: string): void {
    const channel = streamId;
    const { message } = this._formatMessage(event, data, channel, eventId);
    this._fanOut(message, (client) =>
      client.subscriptions.has(streamId) || client.subscriptions.has('*'),
    );
  }

  private _localBroadcastToUser(publicKey: string, event: string, data: unknown, eventId?: string): void {
    const channel = `user:${publicKey}`;
    const { message } = this._formatMessage(event, data, channel, eventId);
    this._fanOut(message, (client) =>
      client.subscriptions.has(channel) || client.subscriptions.has('*'),
    );
  }

  /**
   * Fan a pre-formatted message string out to matching clients.
   * Separated from broadcast() so we can reuse the already-formatted
   * message from _localBroadcastToStream/_localBroadcastToUser without
   * re-serialising.
   */
  private _fanOut(message: string, filter: (client: SSEClient) => boolean): void {
    for (const client of this.clients.values()) {
      if (filter(client)) {
        this.writeToClient(client, message);
      }
    }
  }

  // ─── Accessors ───────────────────────────────────────────────────────────────

  getClientCount(): number {
    return this.clients.size;
  }

  getSlowClientsDropped(): number {
    return this.slowClientsDropped;
  }

  getMaxConnections(): number {
    return this.maxConnections;
  }

  getPerIpPeakConnections(): number {
    return this.perIpPeakConnections;
  }

  getActiveIpCount(): number {
    return this.ipConnectionCounts.size;
  }

  getPerUserPeakConnections(): number {
    return this.perUserPeakConnections;
  }

  getActiveUserCount(): number {
    return this.userConnectionCounts.size;
  }

  getUserConnectionCount(userId: string): number {
    return this.userConnectionCounts.get(userId) ?? 0;
  }

  getReplayBufferSize(): number {
    return this.replayBuffer.length;
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ─── Internal write/remove helpers ─────────────────────────────────────────

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      requestContext.run({ requestId: this.heartbeatWorkerId }, () => {
        this.sendHeartbeat();
      });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private getWritableLength(res: Response): number {
    const response = res as Response & { writableLength?: number };
    if (typeof response.writableLength === 'number') {
      return response.writableLength;
    }
    return res.socket?.writableLength ?? 0;
  }

  private removeClient(clientId: string, reason?: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    this.clients.delete(clientId);
    this.publishConnectionMetrics();
    this.publishQueueDepthMetrics();

    const currentIpCount = this.ipConnectionCounts.get(client.ip) ?? 0;
    if (currentIpCount <= 1) {
      this.ipConnectionCounts.delete(client.ip);
    } else {
      this.ipConnectionCounts.set(client.ip, currentIpCount - 1);
    }

    if (client.userId) {
      const currentUserCount = this.userConnectionCounts.get(client.userId) ?? 0;
      if (currentUserCount <= 1) {
        this.userConnectionCounts.delete(client.userId);
      } else {
        this.userConnectionCounts.set(client.userId, currentUserCount - 1);
      }
    }

    try {
      if (!client.res.writableEnded) {
        client.res.end();
      }
    } catch {
      // Ignore errors while closing a broken connection.
    }

    if (reason) {
      logger.warn(`SSE client removed (${reason}): ${clientId}`);
    }
  }

  private dropSlowClient(client: SSEClient): void {
    this.slowClientsDropped += 1;
    sseClientsDroppedTotal.inc({ reason: 'slow_client' });
    this.removeClient(client.id, 'slow-client');
  }

  /**
   * Low-level write: bypass the queue and write directly to the socket.
   * Only used for replay, heartbeats, and the initial connected event
   * where we must not re-enqueue.
   */
  private _rawWrite(client: SSEClient, message: string): boolean {
    try {
      return client.res.write(message);
    } catch {
      this.removeClient(client.id, 'write-failure');
      return false;
    }
  }

  /**
   * Issue 3: write a message to a client, applying backpressure queue and
   * overflow disconnect.
   *
   * States:
   *  - Not paused: write directly.  If write returns false (kernel buffer
   *    full), mark paused, enqueue, register drain handler.
   *  - Paused: enqueue the message.  If the queue depth exceeds
   *    MAX_CLIENT_QUEUE_DEPTH, drop the client.
   */
  private writeToClient(client: SSEClient, message: string): boolean {
    if (client.paused) {
      // Issue 3: enforce per-client queue limit.
      if (client.queue.length >= this.maxClientQueueDepth) {
        this.dropSlowClient(client);
        return false;
      }
      client.queue.push(message);
      this.publishQueueDepthMetrics();
      return false;
    }

    try {
      const ok = client.res.write(message);

      if (!ok) {
        // Kernel TCP send buffer full — apply backpressure.
        client.paused = true;

        // Issue 3: also check the legacy writable-length threshold.
        if (this.getWritableLength(client.res) >= MAX_WRITABLE_BUFFER) {
          this.dropSlowClient(client);
          return false;
        }

        client.res.once('drain', () => {
          if (!this.clients.has(client.id)) return; // already removed

          client.paused = false;

          // Drain the pending queue.
          while (client.queue.length > 0 && !client.paused) {
            const queued = client.queue.shift()!;
            const drained = client.res.write(queued);
            if (!drained) {
              client.paused = true;
              // Re-register the drain handler for the remaining queue.
              client.res.once('drain', () => {
                if (!this.clients.has(client.id)) return;
                client.paused = false;
                this.publishQueueDepthMetrics();
              });
              break;
            }
          }

          this.publishQueueDepthMetrics();
        });
      }

      return ok;
    } catch {
      this.removeClient(client.id, 'write-failure');
      return false;
    }
  }
}

export const sseService = new SSEService();
export type { SSEClient };

// Publish the configured ceiling once at import time so
// `flowfi_sse_max_connections / flowfi_sse_active_connections{topic="total"}`
// is a usable saturation ratio even before the first client connects.
sseMaxConnections.set(sseService.getMaxConnections());
