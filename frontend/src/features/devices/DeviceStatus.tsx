// Liveness presentation for an attendance device, shared by the list
// page and the detail drawer.
//
// A push device cannot be pinged — the terminal dials us, we never dial
// it — so "online" is a statement about traffic we actually received,
// not about a probe succeeding. Keeping that judgement in one place
// stops the list and the drawer from disagreeing about the same device.

import { useTranslation } from "react-i18next";

import { type Device } from "./types";

export type Liveness = "waiting" | "online" | "unreachable";

export function livenessOf(device: Device): Liveness {
  if (!device.last_event_at) return "waiting";
  if (device.health_status === "unreachable") return "unreachable";
  return "online";
}

const DOT_COLOR: Record<Liveness, string> = {
  online: "var(--success-text)",
  unreachable: "var(--danger-text)",
  waiting: "var(--text-tertiary)",
};

/** Colour-coded dot carrying the same signal as the pill, for scanning. */
export function StatusDot({ device }: { device: Device }) {
  const state = livenessOf(device);
  return (
    <span
      aria-hidden="true"
      style={{
        width: 8,
        height: 8,
        borderRadius: "50%",
        flexShrink: 0,
        background: DOT_COLOR[state],
        // A live device gets a halo so it reads as "now" at a glance.
        boxShadow: state === "online" ? "0 0 0 3px var(--success-soft)" : "none",
      }}
    />
  );
}

export function StatusPill({ device }: { device: Device }) {
  const { t } = useTranslation();
  const state = livenessOf(device);

  if (state === "waiting") {
    return (
      <span className="pill pill-neutral">
        {t("devices.health.waiting", { defaultValue: "No events yet" })}
      </span>
    );
  }
  if (state === "unreachable") {
    return (
      <span className="pill pill-danger">
        {t("devices.health.unreachable", { defaultValue: "Unreachable" })}
      </span>
    );
  }
  return (
    <span className="pill pill-success">
      {t("devices.health.online", { defaultValue: "Online" })}
    </span>
  );
}
