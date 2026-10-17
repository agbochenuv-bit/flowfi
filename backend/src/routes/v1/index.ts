import { Router } from "express";
import streamRoutes from "./streams/index.js";
import eventsRoutes from "./events.routes.js";
import userRoutes from "./user.routes.js";
import authRoutes from "./auth.routes.js";
import adminRoutes from "./admin.routes.js";
import webhookRoutes from "./webhook.routes.js";
import analyticsRoutes from "./analytics.routes.js";
import tokenRoutes from "./token.routes.js";
import {
  principalRateLimit,
  type PrincipalRateLimitOptions,
} from "../../middleware/principalRateLimit.js";

const router = Router();

// Per-route budgets for principal-aware rate limiting.
// Budgets are expressed as { windowMs, max } and are keyed by the resolved
// principal (authenticated account id) with a safe fallback to the client IP
// when the caller is anonymous. Proxy trust is handled by the shared limiter
// (see middleware/principalRateLimit.ts) so spoofed forwarding headers do not
// bypass the budget. When Redis is unavailable the limiter falls back to an
// in-memory counter so requests are still bounded per instance.
const analyticsBudget: PrincipalRateLimitOptions = {
  name: "analytics",
  windowMs: 60_000,
  max: 60,
  scope: "principal",
};

const webhookBudget: PrincipalRateLimitOptions = {
  name: "webhooks",
  windowMs: 60_000,
  max: 120,
  scope: "principal",
};

const accountBudget: PrincipalRateLimitOptions = {
  name: "account",
  windowMs: 60_000,
  max: 30,
  scope: "principal",
};

const exportBudget: PrincipalRateLimitOptions = {
  name: "export",
  windowMs: 60_000,
  max: 5,
  scope: "principal",
};

const adminBudget: PrincipalRateLimitOptions = {
  name: "admin",
  windowMs: 60_000,
  max: 60,
  scope: "principal",
};

// V1 API Routes
router.use("/streams", streamRoutes);
router.use("/events", eventsRoutes);
router.use(
  "/users",
  principalRateLimit(accountBudget),
  principalRateLimit(exportBudget, { match: /\/export(\/|$)/ }),
  userRoutes,
);
router.use("/auth", authRoutes);
router.use("/webhooks", principalRateLimit(webhookBudget), webhookRoutes);
router.use("/analytics", principalRateLimit(analyticsBudget), analyticsRoutes);
router.use("/tokens", tokenRoutes);

// Admin routes
router.use("/admin", principalRateLimit(adminBudget), adminRoutes);

export default router;