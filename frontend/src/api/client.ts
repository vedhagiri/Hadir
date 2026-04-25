// Tiny fetch wrapper used by all Hadir frontend API calls.
//
// The dev server at :5173 proxies `/api/*` to the FastAPI backend at :8000
// (see vite.config.ts), so the browser sees everything as same-origin and
// the `hadir_session` cookie flows without any CORS handling. We still set
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
    throw new ApiError(response.status, parsed);
  }
  return parsed as T;
}
