"""Read-only audit log endpoints (P11). Admin-only.

The append-only contract sits at the database grant level (P2). This
package only exposes SELECT — there's no UPDATE/DELETE handler to add
even by accident.
"""

from hadir.audit_log.router import router

__all__ = ["router"]
