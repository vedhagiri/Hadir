"""Branded HTML result page for failed SSO (Microsoft / Google) sign-ins.

The OIDC callback is a top-level browser navigation, so a failure must
render something a human wants to look at — not raw JSON and not a bare
redirect. This module returns a self-contained, inline-styled page
(no external assets, CSP-safe) that shows a friendly message plus a
"Back to sign in" button. Both ``oidc.py`` (Entra) and
``google_oidc.py`` return it on every callback failure.

Everything shown is derived from a fixed ``code``/``provider`` set —
no request input is interpolated into the HTML — so there is no
injection surface.
"""

from __future__ import annotations

from fastapi.responses import HTMLResponse

# code -> (title, message-template, http status). ``{provider}`` is the
# only placeholder and is filled from the fixed provider name.
_MESSAGES: dict[str, tuple[str, str, int]] = {
    "not_registered": (
        "Account not registered",
        "Your {provider} account is not registered in Maugood. "
        "Contact your administrator.",
        403,
    ),
    "email_not_verified": (
        "Email not verified",
        "Your {provider} email address isn’t verified. Verify it with "
        "{provider} and try again.",
        403,
    ),
    "domain_not_allowed": (
        "Domain not allowed",
        "Your account’s domain isn’t permitted for this workspace. "
        "Contact your administrator.",
        403,
    ),
    "not_configured": (
        "Sign-in unavailable",
        "{provider} sign-in isn’t fully configured for this workspace. "
        "Contact your administrator.",
        400,
    ),
    "provider_error": (
        "Sign-in error",
        "{provider} reported an error during sign-in. Please try again.",
        400,
    ),
    "verify_failed": (
        "Verification failed",
        "We couldn’t verify your {provider} sign-in. Please try again.",
        400,
    ),
    "session_expired": (
        "Session expired",
        "Your sign-in session expired before it completed. Please try again.",
        400,
    ),
}
_DEFAULT = (
    "Sign-in failed",
    "{provider} sign-in didn’t complete. Please try again.",
    400,
)

_PROVIDER_NAMES = {"google": "Google", "microsoft": "Microsoft"}

# Inline provider marks (official press-kit paths), kept tiny.
_GOOGLE_MARK = (
    '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">'
    '<path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/>'
    '<path fill="#FF3D00" d="M6.3 14.1l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.1z"/>'
    '<path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.4-4.5 2.4-7.2 2.4-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z"/>'
    '<path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.2 4.2-4.1 5.6l6.2 5.2C40.9 35.3 44 30 44 24c0-1.3-.1-2.4-.4-3.5z"/>'
    "</svg>"
)
_MICROSOFT_MARK = (
    '<svg width="18" height="18" viewBox="0 0 23 23" aria-hidden="true">'
    '<rect x="1" y="1" width="10" height="10" fill="#f25022"/>'
    '<rect x="12" y="1" width="10" height="10" fill="#7fba00"/>'
    '<rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>'
    '<rect x="12" y="12" width="10" height="10" fill="#ffb900"/>'
    "</svg>"
)


def _mark(provider: str) -> str:
    return _MICROSOFT_MARK if provider == "microsoft" else _GOOGLE_MARK


def render_sso_error_html(code: str, provider: str) -> str:
    provider_name = _PROVIDER_NAMES.get(provider, "SSO")
    title, message_tmpl, _status = _MESSAGES.get(code, _DEFAULT)
    message = message_tmpl.format(provider=provider_name)
    mark = _mark(provider)
    # ``data-sso-error`` is a stable hook for tests + support triage.
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} · Maugood</title>
<style>
  * {{ box-sizing: border-box; }}
  html, body {{ height: 100%; margin: 0; }}
  body {{
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1a17;
    background: radial-gradient(1200px 600px at 50% -10%, #ffffff 0%, #f4f1ec 55%, #ebe6de 100%);
    display: grid; place-items: center; padding: 24px;
  }}
  .card {{
    width: 100%; max-width: 440px; background: #fff;
    border: 1px solid #ece7df; border-radius: 20px;
    box-shadow: 0 24px 70px rgba(40,33,20,0.10);
    padding: 40px 36px 30px; text-align: center;
  }}
  .provider {{
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12px; font-weight: 600; letter-spacing: .02em; color: #6b655c;
    background: #f6f3ee; border: 1px solid #ece7df; border-radius: 999px;
    padding: 6px 12px; margin-bottom: 22px;
  }}
  .icon {{
    width: 66px; height: 66px; border-radius: 50%; margin: 0 auto 20px;
    display: grid; place-items: center;
    background: #fef3c7; color: #b45309;
    box-shadow: 0 0 0 8px rgba(180,83,9,0.06);
  }}
  h1 {{
    font-family: Georgia, "Times New Roman", serif;
    font-size: 25px; font-weight: 600; margin: 0 0 10px; letter-spacing: -0.01em;
  }}
  p.msg {{ color: #5b544a; font-size: 15px; line-height: 1.6; margin: 0 auto 26px; max-width: 340px; }}
  .btn {{
    display: inline-block; background: #17140f; color: #fff; text-decoration: none;
    font-size: 14px; font-weight: 600; padding: 12px 24px; border-radius: 11px;
    transition: transform .06s ease, background .15s ease;
  }}
  .btn:hover {{ background: #2a251d; }}
  .btn:active {{ transform: translateY(1px); }}
  .foot {{
    margin-top: 30px; padding-top: 18px; border-top: 1px solid #f0ece5;
    color: #a49c8f; font-size: 12px; line-height: 1.5;
  }}
  .foot b {{ color: #6b655c; font-weight: 600; }}
</style>
</head>
<body>
  <main class="card" data-sso-error="{code}" data-sso-provider="{provider}">
    <div class="provider">{mark}<span>{provider_name}</span></div>
    <div class="icon" aria-hidden="true">
      <svg width="30" height="30" viewBox="0 0 24 24" fill="none"
           stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
    </div>
    <h1>{title}</h1>
    <p class="msg">{message}</p>
    <a class="btn" href="/login">Back to sign in</a>
    <div class="foot">
      <b>Maugood</b> · Camera-based attendance<br>
      Powered by Muscat Tech Solutions
    </div>
  </main>
</body>
</html>"""


def sso_error_response(code: str, provider: str) -> HTMLResponse:
    """Return the branded HTML page with the code's semantic HTTP status."""

    _title, _msg, status = _MESSAGES.get(code, _DEFAULT)
    return HTMLResponse(content=render_sso_error_html(code, provider), status_code=status)
