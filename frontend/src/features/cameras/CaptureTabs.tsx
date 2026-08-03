// Shared tab strip for the capture section: Cameras | Devices.
// Route-linked (not local state) so each list keeps its own page/URL.
// Rendered at the top of both CamerasPage and DevicesPage.

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Icon } from "../../shell/Icon";

type CaptureTab = "cameras" | "devices";

const TABS: { id: CaptureTab; path: string; icon: "videocam" | "shield" }[] = [
  { id: "cameras", path: "/cameras", icon: "videocam" },
  { id: "devices", path: "/devices", icon: "shield" },
];

export function CaptureTabs({ active }: { active: CaptureTab }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div
      role="tablist"
      aria-label={t("capture.tabsAria", { defaultValue: "Capture sources" })}
      style={{
        display: "flex",
        gap: 2,
        marginBottom: 16,
        borderBottom: "1px solid var(--border)",
      }}
    >
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => {
              if (!isActive) navigate(tab.path);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: "8px 16px",
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
              color: isActive ? "var(--text)" : "var(--text-secondary)",
              background: "none",
              border: "none",
              borderBottom: isActive
                ? "2px solid var(--text)"
                : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -1,
              transition: "color 0.15s, border-color 0.15s",
              fontFamily: "var(--font-sans)",
            }}
          >
            <Icon name={tab.icon} size={14} />
            {tab.id === "cameras"
              ? t("capture.tabCameras", { defaultValue: "Cameras" })
              : t("capture.tabDevices", { defaultValue: "Devices" })}
          </button>
        );
      })}
    </div>
  );
}
