export class AuthExpiredError extends Error {
  constructor() {
    super("Your wallet session expired. Reconnect your wallet to continue.");
    this.name = "AuthExpiredError";
  }
}

export function getJwtExpiry(token: string): number | null {
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      exp?: number;
    };
    return typeof decoded.exp === "number" ? decoded.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  token?: string | null,
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("flowfi:auth-expired"));
    }
    throw new AuthExpiredError();
  }
  return response;
}