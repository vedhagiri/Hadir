// Tenant Admin "Settings → Branding" page. Reads the caller's branding,
// renders the shared form, and applies the preview to the live document
// so the Admin sees their shell update as they pick.

import { SettingsTabs } from "../settings/SettingsTabs";
import { BrandingForm } from "./BrandingForm";
import {
  useDeleteMyLogo,
  useMyBranding,
  usePatchMyBranding,
  useUploadMyLogo,
} from "./hooks";

export function BrandingPage() {
  const branding = useMyBranding();
  const patch = usePatchMyBranding();
  const upload = useUploadMyLogo();
  const remove = useDeleteMyLogo();

  if (branding.isLoading) return <p>Loading branding…</p>;
  if (branding.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>Couldn’t load branding.</p>
    );
  if (!branding.data) return <p>Sign in to manage branding.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <SettingsTabs />
      <header>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontSize: 28,
            margin: "0 0 4px 0",
            fontWeight: 400,
          }}
        >
          Branding
        </h1>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 13 }}>
          Pick a primary colour from the curated palette, choose one of three
          fonts, and upload a small logo. Changes apply on save.
        </p>
      </header>
      <BrandingForm
        branding={branding.data}
        logoUrl="/api/branding/logo"
        onPatch={(input) => patch.mutateAsync(input)}
        onLogoUpload={(file) => upload.mutateAsync(file)}
        onLogoDelete={() => remove.mutateAsync()}
        applyToDocument
      />
    </div>
  );
}
