"""Dev-only test helpers (P13).

These endpoints exist purely to make the Playwright smoke test runnable
without a live camera or a 15-minute wait for the attendance scheduler.

**Red line (pilot-plan P13)**: this router is only mounted when
``HADIR_ENV=dev``. ``hadir.main.create_app`` checks the setting and
refuses to attach the router otherwise — so a production build (env
=staging|production) cannot serve these paths even if an operator
were to import the module by accident.
"""

from hadir._test_endpoints.router import router

__all__ = ["router"]
