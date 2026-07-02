// Wire types for the Entra ID OIDC flow (v1.0 P6).
// Mirrors the Pydantic responses in ``maugood/auth/oidc.py``.

export interface OidcStatusResponse {
  enabled: boolean;
  has_config: boolean;
}

export interface OidcConfigResponse {
  tenant_id: number;
  entra_tenant_id: string;
  client_id: string;
  has_secret: boolean;
  enabled: boolean;
  updated_at: string;
  redirect_uri: string;
}

export interface OidcConfigPatchInput {
  entra_tenant_id?: string;
  client_id?: string;
  // Empty string / undefined means "leave the stored secret untouched".
  // A non-empty string replaces it. Same convention as the RTSP URL
  // pattern from pilot P7.
  client_secret?: string;
  enabled?: boolean;
}

// --- Google Sign-In (OIDC) ------------------------------------------------
// Mirrors the Pydantic responses in ``maugood/auth/google_oidc.py``.

export interface GoogleOidcConfigResponse {
  tenant_id: number;
  client_id: string;
  has_secret: boolean;
  allowed_domain: string;
  enabled: boolean;
  updated_at: string;
  redirect_uri: string;
}

export interface GoogleOidcConfigPatchInput {
  client_id?: string;
  // Empty string / undefined means "leave the stored secret untouched".
  client_secret?: string;
  // Optional Google Workspace hosted-domain restriction. Empty = any.
  allowed_domain?: string;
  enabled?: boolean;
}
