// Persistent red banner (P3). Renders inside the tenant Layout when
// /api/auth/me reports we're a Super-Admin in impersonation mode.
// Clicking it ends the impersonation and routes back to the console.
//
// Red line: this banner is a SAFETY FEATURE, not a cosmetic. Do not
// hide it, soften the colour, or move it off the top.

import { useNavigate } from "react-router-dom";

import { ApiError } from "../api/client";
import { useExitImpersonation } from "../super-admin/SuperAdminProvider";

interface Props {
  superAdminUserId: number | null;
}

export function ImpersonationBanner({ superAdminUserId }: Props) {
  const exit = useExitImpersonation();
  const navigate = useNavigate();

  const onClick = async () => {
    try {
      await exit.mutateAsync();
    } catch (err) {
      if (err instanceof ApiError) {
        // Surface the error but still attempt to redirect — the user
        // should never be stranded inside an impersonation context.
        console.error("exit impersonation failed", err);
      }
    }
    navigate("/super-admin/tenants", { replace: true });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={exit.isPending}
      style={{
        display: "block",
        width: "100%",
        background: "#c0392b",
        color: "white",
        border: "none",
        padding: "10px 16px",
        fontWeight: 600,
        fontSize: 13,
        cursor: "pointer",
        textAlign: "center",
      }}
    >
      ⚠ Viewing as SuperAdmin
      {superAdminUserId != null ? ` (operator #${superAdminUserId})` : ""} —{" "}
      <span style={{ textDecoration: "underline" }}>click to exit impersonation</span>
    </button>
  );
}
