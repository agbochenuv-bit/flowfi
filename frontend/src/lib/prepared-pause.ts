// This in-memory intent is never a signed envelope. The signing path rebuilds
// and simulates a fresh transaction after the user explicitly reconnects.
interface PauseContext {
  streamId: string;
  account: string;
  network: string;
  revision: string;
}

export function preparePause(context: PauseContext) {
  const expiresAt = Date.now() + 5 * 60_000;
  let consumed = false;
  function validate(current: PauseContext) {
    if (Date.now() >= expiresAt) throw new Error("Prepared pause expired");
    if (!context.revision || current.revision !== context.revision ||
        current.streamId !== context.streamId || current.account !== context.account ||
        current.network !== context.network) throw new Error("Prepared pause is stale");
  }
  return {
    expiresAt,
    claim(current: PauseContext) {
      if (consumed) throw new Error("Prepared pause already used");
      consumed = true;
      validate(current);
    },
    validate,
  };
}
