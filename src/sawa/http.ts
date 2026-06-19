/**
 * Tiny GET-only HTTP helper. READ-ONLY BY CONSTRUCTION: this module never issues
 * POST/PUT/PATCH/DELETE — a static test (tests/read-only.test.ts) enforces that.
 */

export class UpstreamError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export async function getJson<T>(
  url: string | URL,
  headers: Record<string, string>,
  timeoutMs = 10_000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: controller.signal });
    if (!res.ok) {
      throw new UpstreamError(res.status, `GET ${String(url)} → ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}
