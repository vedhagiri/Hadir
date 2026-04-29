"""Backend i18n (v1.0 P21).

Server-originated strings — email subjects, notification bodies,
report headers, end-user error messages — are looked up via dotted
keys against per-locale YAML files in this directory.

The runtime is intentionally tiny: load each YAML once at import,
expose ``t(key, lang, **fmt)``. No interpolation library — Python's
``str.format`` covers every case in the message store. Missing keys
return the key itself so failures land visibly in the UI rather than
silently falling back to English.
"""

from maugood.i18n.locale import (
    SUPPORTED_LANGUAGES,
    DEFAULT_LANGUAGE,
    parse_accept_language,
    resolve_language,
    t,
)

__all__ = [
    "SUPPORTED_LANGUAGES",
    "DEFAULT_LANGUAGE",
    "parse_accept_language",
    "resolve_language",
    "t",
]
