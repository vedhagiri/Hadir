// Where to go after signing in again. Set by the session-expired dialog
// (the page the user was on); read once by the login page. Same-origin
// paths only, so it can never become an open redirect.

const KEY = "maugood.returnTo";

function safe(path: string | null): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//") || path.startsWith("/login")) return null;
  return path;
}

export function rememberReturnTo(path: string): void {
  const p = safe(path);
  try {
    if (p) sessionStorage.setItem(KEY, p);
  } catch {
    /* storage unavailable — fall back to the dashboard */
  }
}

export function takeReturnTo(): string | null {
  try {
    const p = safe(sessionStorage.getItem(KEY));
    sessionStorage.removeItem(KEY);
    return p;
  } catch {
    return null;
  }
}
