"""Microsoft Entra (Azure AD) user sync + group→role mapping.

Admin-initiated: pulls directory users via Microsoft Graph
(client-credentials, reusing the Entra app configured for OIDC) and
provisions/updates Maugood ``users``. An explicit, admin-configured
``entra_group_role_map`` seeds roles from group membership — a
deliberate, auditable exception to the "roles never from claims" rule,
chosen per tenant and always overridable by the manual role editor.
"""
