import { Router } from 'express';
import authRoutes from './auth.routes.js';
import streamRoutes from './stream.routes.js';
import eventsRoutes from './events.routes.js';
import webhookRoutes from './webhook.routes.js';
import userRoutes from './user.routes.js';
import analyticsRoutes from './analytics.routes.js';
import tokenRoutes from './token.routes.js';
import adminRoutes from './admin.routes.js';

const router = Router();

/**
 * V1 API route registration.
 *
 * The version prefix (/v1) is stripped by apiVersionMiddleware before these
 * routes are matched, so all paths here are relative (e.g. /streams not
 * /v1/streams).
 */

// Authentication — wallet challenge / verify flow
router.use('/auth', authRoutes);

// Payment streams — create, query, lifecycle actions
router.use('/streams', streamRoutes);

// Server-Sent Events — ticket issuance and SSE subscription
router.use('/events', eventsRoutes);

// Webhooks — CRUD and delivery management
router.use('/webhooks', webhookRoutes);

// Users — per-wallet aggregates
router.use('/users', userRoutes);

// Analytics — TVL, historical time-series, DefiLlama adapter
router.use('/analytics', analyticsRoutes);

// Verified token metadata
router.use('/tokens', tokenRoutes);

// Admin — indexer management, backfill, dead-letter (requires admin JWT)
router.use('/admin', adminRoutes);

export default router;
