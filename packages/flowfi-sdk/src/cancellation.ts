export interface OperationOptions {
  signal?: AbortSignal;
  /** Maximum time for the complete operation, in milliseconds. */
  timeoutMs?: number;
}

export function abortError(reason?: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' ? reason : 'The operation was aborted');
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal.reason));

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export async function withAbortSignal<T>(
  transport: unknown,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const interceptors = (transport as {
    httpClient?: {
      interceptors?: {
        request?: {
          use?: (handler: (config: { signal?: AbortSignal }) => { signal?: AbortSignal }) => number;
          eject?: (id: number) => void;
        };
      };
    };
  }).httpClient?.interceptors?.request;
  const interceptorId = interceptors?.use?.((config) => ({ ...config, signal }));
  try {
    return await abortable(operation(), signal);
  } finally {
    if (interceptorId !== undefined) interceptors?.eject?.(interceptorId);
  }
}

export async function runWithCancellation<T>(
  options: OperationOptions | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutMs = options?.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new Error('timeoutMs must be a finite number >= 0');
  }

  const externalSignal = options?.signal;
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) onExternalAbort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const timer = timeoutMs === undefined
    ? undefined
    : setTimeout(() => {
        const error = new Error(`Operation timed out after ${timeoutMs}ms`);
        error.name = 'TimeoutError';
        controller.abort(error);
      }, timeoutMs);

  try {
    throwIfAborted(controller.signal);
    const pending = Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return operation(controller.signal);
    });
    return await abortable(pending, controller.signal);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}