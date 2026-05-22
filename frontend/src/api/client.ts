// Tiny fetch wrapper used by all Maugood frontend API calls.
//
// The dev server at :5173 proxies `/api/*` to the FastAPI backend at :8000
// (see vite.config.ts), so the browser sees everything as same-origin and
// the `maugood_session` cookie flows without any CORS handling. We still set
// `credentials: "same-origin"` explicitly so future reviewers don't have
// to re-derive that property from defaults.

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    message?: string,
  ) {
    super(message ?? `API ${status}`);
  }
}

// ── Refresh gate ────────────────────────────────────────────────────────────
// When any non-auth API call gets a 401, the first caller attempts one silent
// POST /api/auth/refresh.  All concurrent 401s wait on the same Promise so
// the refresh endpoint is never hammered and each caller retries once after
// a successful refresh rather than surfacing the error immediately.
let _refreshGate: Promise<boolean> | null = null;

const _NO_REFRESH_PATHS = new Set([
  "/api/auth/refresh",
  "/api/auth/login",
  "/api/auth/logout",
]);

async function _tryRefresh(): Promise<boolean> {
  try {
    const r = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    return r.ok;
  } catch {
    return false;
  }
}


// BUG-002 — unified error-to-string extractor. Every Maugood backend
// endpoint returns errors as either a plain string ``detail`` or a
// structured ``{field, message}`` dict (the validation pattern).
// Callers across the frontend re-implement this same parse — this
// helper folds it into one place so error wording stays consistent.
export function extractApiError(err: unknown, fallback = "Something went wrong"): string {
  if (err instanceof ApiError) {
    const body = err.body as { detail?: unknown } | null;
    const detail = body?.detail;
    if (typeof detail === "string") return detail;
    if (detail && typeof detail === "object") {
      const d = detail as { message?: string; field?: string };
      if (d.message) {
        return d.field ? `${d.field}: ${d.message}` : d.message;
      }
    }
    return `${fallback} (HTTP ${err.status})`;
  }
  if (err instanceof Error) return err.message || fallback;
  return fallback;
}

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  // JSON by default. Pass a FormData to send multipart (the browser then
  // sets its own multipart boundary header — we don't touch Content-Type).
  body?: unknown;
  signal?: AbortSignal;
}

export async function api<T>(path: string, init: ApiRequest = {}): Promise<T> {
  const { method = "GET", body, signal } = init;
  const headers: Record<string, string> = {};
  const request: RequestInit = {
    method,
    headers,
    credentials: "same-origin",
  };
  if (body !== undefined) {
    if (body instanceof FormData) {
      request.body = body;
    } else {
      headers["Content-Type"] = "application/json";
      request.body = typeof body === "string" ? body : JSON.stringify(body);
    }
  }
  if (signal) {
    request.signal = signal;
  }

  const response = await fetch(path, request);

  // Parse JSON lazily — 204 and network errors don't carry a body.
  let parsed: unknown = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    // On 401: try one silent refresh (serialised across concurrent callers),
    // then replay the original request once.  Skip for auth endpoints to
    // avoid infinite loops and to let explicit sign-in/out flows surface the
    // 401 directly to their own error handlers.
    if (response.status === 401 && !_NO_REFRESH_PATHS.has(path)) {
      if (!_refreshGate) {
        _refreshGate = _tryRefresh().finally(() => {
          _refreshGate = null;
        });
      }
      const refreshed = await _refreshGate;
      if (refreshed) {
        // Replay original request once after a successful refresh.
        const r2 = await fetch(path, request);
        let b2: unknown = null;
        const t2 = await r2.text();
        if (t2) {
          try {
            b2 = JSON.parse(t2);
          } catch {
            b2 = t2;
          }
        }
        if (r2.ok) return b2 as T;
        throw new ApiError(r2.status, b2);
      }
    }
    throw new ApiError(response.status, parsed);
  }
  return parsed as T;
}
