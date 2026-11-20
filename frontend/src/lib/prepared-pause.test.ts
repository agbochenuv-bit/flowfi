import { afterEach, expect, it, vi } from "vitest";
import { preparePause } from "./prepared-pause";
const context = { account: "a", streamId: "1", network: "testnet", revision: "v1" };
afterEach(() => vi.useRealTimers());
it("claims once on reconnect", () => {
  const draft = preparePause(context);
  draft.claim(context);
  expect(() => draft.claim(context)).toThrow("already used");
});
it.each(Object.keys(context))("rechecks %s before signing", key => {
  const draft = preparePause(context);
  draft.claim(context);
  expect(() => draft.validate({...context, [key]: "changed"})).toThrow("stale");
});
it("rejects at the expiry boundary after claim", () => {
  vi.useFakeTimers();
  const draft = preparePause(context);
  draft.claim(context);
  vi.setSystemTime(draft.expiresAt);
  expect(() => draft.validate(context)).toThrow("expired");
});
