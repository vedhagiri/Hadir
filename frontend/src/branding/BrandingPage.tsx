// Tenant Admin "Settings → Branding" page. Reads the caller's branding,
// renders the shared form, and applies the preview to the live document
// so the Admin sees their shell update as they pick.

import { useTranslation } from "react-i18next";

import { LoadErrorPanel, SettingsPage } from "../settings/settingsUi";
import { BrandingForm } from "./BrandingForm";
import {
  useDeleteMyLogo,
  useMyBranding,
  usePatchMyBranding,
  useUploadMyLogo,
} from "./hooks";
import { SkeletonPanel } from "../components/Skeleton";

export function BrandingPage() {
  const { t } = useTranslation();
  const branding = useMyBranding();
  const patch = usePatchMyBranding();
  const upload = useUploadMyLogo();
  const remove = useDeleteMyLogo();

  let body: React.ReactNode;
  if (branding.isLoading) {
    body = (
      <>
        <SkeletonPanel lines={2} />
        <SkeletonPanel lines={3} />
        <SkeletonPanel lines={4} />
      </>
    );
  } else if (branding.error) {
    body = (
      <LoadErrorPanel
        title={t("branding.loadFailedPage")}
        onRetry={() => void branding.refetch()}
      />
    );
  } else if (!branding.data) {
    body = <LoadErrorPanel title={t("branding.signInRequired")} />;
  } else {
    body = (
      <BrandingForm
        branding={branding.data}
        logoUrl="/api/branding/logo"
        onPatch={(input) => patch.mutateAsync(input)}
        onLogoUpload={(file) => upload.mutateAsync(file)}
        onLogoDelete={() => remove.mutateAsync()}
        applyToDocument
      />
    );
  }

  return (
    <SettingsPage title={t("branding.title")} subtitle={t("branding.subtitle")}>
      {body}
    </SettingsPage>
  );
}
