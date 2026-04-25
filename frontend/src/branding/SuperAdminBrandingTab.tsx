// Super-Admin tenant-detail "Branding" tab. Operator targets a
// specific tenant by id; the form is the same component the tenant
// Admin uses, but ``applyToDocument`` is left off because the
// operator is in the red-accented console and shouldn't see their
// own shell repaint while editing another tenant's branding.

import { BrandingForm } from "./BrandingForm";
import {
  useDeleteTenantLogo,
  usePatchTenantBranding,
  useTenantBranding,
  useUploadTenantLogo,
} from "./hooks";

export function SuperAdminBrandingTab({ tenantId }: { tenantId: number }) {
  const branding = useTenantBranding(tenantId);
  const patch = usePatchTenantBranding(tenantId);
  const upload = useUploadTenantLogo(tenantId);
  const remove = useDeleteTenantLogo(tenantId);

  if (branding.isLoading) return <p>Loading branding…</p>;
  if (branding.error)
    return (
      <p style={{ color: "var(--danger-text)" }}>Couldn’t load branding.</p>
    );
  if (!branding.data) return null;

  return (
    <BrandingForm
      branding={branding.data}
      logoUrl={`/api/super-admin/tenants/${tenantId}/branding/logo`}
      onPatch={(input) => patch.mutateAsync(input)}
      onLogoUpload={(file) => upload.mutateAsync(file)}
      onLogoDelete={() => remove.mutateAsync()}
    />
  );
}
