// Button primitive with built-in async-loading state.
//
// **Why this exists**: every form across Hadir has its own
// ``setSubmitting(true)`` ... ``finally setSubmitting(false)`` dance.
// Centralising it here means the spinner + disabled state come for
// free when ``onClick`` returns a Promise — no boilerplate per
// consumer.
//
// **Visual contract** (matches the design's ``.btn`` family):
// * Picks a variant class from ``variant``: ``primary``, ``accent``,
//   ``danger``, ``ghost``, or the default outlined style.
// * Hover lift + shadow inherited from the global
//   ``transitions.css`` rule on ``.btn`` (P28.x animation polish).
// * When ``loading`` is true: renders an inline spinner before the
//   children, dims the children to 60 %, and disables the button.
// * Reduced motion: the spinner still spins (it's a status
//   indicator, not decorative).

import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type Variant = "primary" | "accent" | "danger" | "ghost" | "default";

interface Props
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> {
  /** Click handler. May return a Promise — the button auto-shows
   *  the spinner + disables itself until the promise settles. */
  onClick?: () => void | Promise<void>;
  /** Variant — picks the design's ``.btn-{variant}`` class. */
  variant?: Variant;
  /** Force the loading state from the parent (e.g. when the parent
   *  already tracks isPending from TanStack Query). */
  isLoading?: boolean;
  /** Smaller padding + smaller font, mirroring ``.btn-sm``. */
  size?: "sm" | "md";
  children: ReactNode;
}

export function Button({
  onClick,
  variant = "default",
  isLoading,
  size = "md",
  disabled,
  className,
  children,
  ...rest
}: Props) {
  const [internalLoading, setInternalLoading] = useState(false);
  const loading = !!isLoading || internalLoading;

  const handleClick = async () => {
    if (loading || disabled || !onClick) return;
    const result = onClick();
    if (result instanceof Promise) {
      setInternalLoading(true);
      try {
        await result;
      } finally {
        setInternalLoading(false);
      }
    }
  };

  // Build the className from the design's existing primitives so
  // the visual matches the rest of the app verbatim.
  const variantClass = variant === "default" ? "" : ` btn-${variant}`;
  const sizeClass = size === "sm" ? " btn-sm" : "";
  const finalClass = `btn${variantClass}${sizeClass}${className ? ` ${className}` : ""}`;

  return (
    <button
      {...rest}
      type={rest.type ?? "button"}
      className={finalClass}
      onClick={() => void handleClick()}
      disabled={loading || disabled}
      aria-busy={loading}
    >
      {loading && (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 12,
            height: 12,
            border: "1.5px solid currentColor",
            borderTopColor: "transparent",
            borderRadius: "50%",
            animation: "hadir-spin 0.7s linear infinite",
            // Slight nudge so the spinner sits on the text baseline.
            verticalAlign: "-1px",
          }}
        />
      )}
      <span style={{ opacity: loading ? 0.6 : 1 }}>{children}</span>
    </button>
  );
}
