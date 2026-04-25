"""Render the report-email body via Jinja.

The template under ``templates/report.html`` consumes a small dict
context — branding (accent hex + tenant name), schedule metadata,
run row, and delivery info (attached vs link). The runner +
test-send endpoint share this helper so the look is identical.
"""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape


_TEMPLATE_DIR = Path(__file__).parent / "templates"

_jinja_env = Environment(
    loader=FileSystemLoader(_TEMPLATE_DIR),
    autoescape=select_autoescape(("html", "xml")),
    trim_blocks=True,
    lstrip_blocks=True,
)


def render_report_email_html(*, context: dict) -> str:
    template = _jinja_env.get_template("report.html")
    return template.render(**context)


def render_notification_email_html(*, context: dict) -> str:
    template = _jinja_env.get_template("notification.html")
    return template.render(**context)
