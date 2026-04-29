"""Shift policies + per-tenant policy assignments (v1.0 P9).

The pilot's single-policy-per-tenant world (one Fixed row in
``shift_policies``) is generalised here into:

* Multiple policies per tenant — Fixed and Flex are the two types
  P9 implements; Ramadan / Custom slots reserved for later phases.
* ``policy_assignments`` rows that map a policy to a resolution
  scope (tenant / department / employee).

The engine never reads from these tables. Resolution lives in
``maugood.attendance.repository.resolve_policies_for_employees`` and
feeds the engine the resolved ``ShiftPolicy``.
"""

from maugood.policies.router import router

__all__ = ["router"]
