import { AsyncLocalStorage } from 'async_hooks';
import { createLogger, format, transports } from 'winston';

export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

const SENSITIVE_KEY_PATTERN = /secret|token|password|authorization|cookie|api[-_]?key|payload|requestBody|responseBody/i;
const SENSITIVE_TEXT_PATTERNS = [
  /\bG[A-Z2-7]{55}\b/g,
  /\bM[A-Z2-7]{68}\b/g,
  /\bS[A-Z2-7]{55}\b/g,
  /https?:\/\/[^\s"'<>]+/gi,
  /\bBearer\s+[^\s,;]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
];

function redactText(value: string): string {
  return SENSITIVE_TEXT_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
}

export function redactLogValue(
  value: unknown,
  key?: string,
  seen = new WeakSet<object>(),
): unknown {
  if (key && SENSITIVE_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactText(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactText(value.message),
      ...(value.stack ? { stack: redactText(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const redacted = value.map((entry) => redactLogValue(entry, undefined, seen));
    seen.delete(value);
    return redacted;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const redacted = Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactLogValue(entryValue, entryKey, seen),
      ]),
    );
    seen.delete(value);
    return redacted;
  }
  return value;
}

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp(),
    format((info) => {
      for (const key of Object.keys(info)) {
        info[key] = redactLogValue(info[key], key);
      }
      return info;
    })(),
    format((info) => {
      const ctx = requestContext.getStore();
      if (ctx?.requestId) info.requestId = ctx.requestId;
      return info;
    })(),
    format.json(),
  ),
  transports: [new transports.Console()],
});

export default logger;
