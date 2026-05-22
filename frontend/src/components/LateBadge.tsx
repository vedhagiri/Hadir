// Shared "Late" attendance badge — one visual recipe reused across
// the Per Person calendar cell, the Day Detail drawer, and the
// dashboard attendance summary pills, so a Late day looks identical
// everywhere an operator might see it.
//
// Visual is deliberately stronger than the generic ``.pill pill-warning``
// shape — bold uppercase + a clock icon + warning border — because
// Late is the status operators most often need to act on (verify the
// in-time, possibly accept an exception). Other status pills stay
// soft because they communicate state, not call-to-action.
//
// Two sizes:
// * ``sm`` — calendar day cells (tight, ~22 px tall)
// * ``md`` — drawer header + dashboard rows (~26 px tall)

import { useTranslation } from "react-i18next";

import { Icon } from "../shell/Icon";

interface Props {
  /** ``sm`` for compact calendar cells; ``md`` for surfaces with
   *  more vertical room. */
  size?: "sm" | "md";
}

export function LateBadge({ size = "md" }: Props): JSX.Element {
  const { t } = useTranslation();
  const isSm = size === "sm";
  return (
    <span
      role="status"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: isSm ? 3 : 5,
        padding: isSm ? "1px 6px" : "3px 9px",
        background: "var(--warning-soft)",
        color: "var(--warning-text)",
        border: "1px solid var(--warning-text)",
        borderRadius: 999,
        fontWeight: 700,
        fontSize: isSm ? 10 : 11.5,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        // Tiny shadow so the warning ring stays legible against the
        // ``--warning-soft`` cell tint behind it.
        boxShadow:
          "0 1px 2px color-mix(in oklab, var(--warning-text) 18%, transparent)",
      }}
    >
      <Icon name="clock" size={isSm ? 9 : 11} />
      <span>{t("calendar.lateShort", { defaultValue: "Late" }) as string}</span>
    </span>
  );
}
