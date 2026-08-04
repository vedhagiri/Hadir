// Presentation helpers shared by the devices list and the detail drawer.
//
// Terminals speak in their own vocabulary — a Hikvision verify mode
// arrives as ``faceOrFpOrCardOrPw``, which is the vendor's identifier,
// not something an HR operator should be asked to decode. These helpers
// translate device vocabulary into operator vocabulary and stay pure so
// both surfaces render the same words.

import type { TFunction } from "i18next";

type T = TFunction<"translation", undefined>;

// Known verification factors, lower-cased. Anything unrecognised is
// passed through title-cased rather than hidden — a new factor should
// still be readable, just not polished.
const VERIFY_FACTORS: Record<string, { key: string; fallback: string }> = {
  face: { key: "devices.verify.face", fallback: "Face" },
  fp: { key: "devices.verify.fingerprint", fallback: "Finger" },
  fingerprint: { key: "devices.verify.fingerprint", fallback: "Finger" },
  card: { key: "devices.verify.card", fallback: "Card" },
  pw: { key: "devices.verify.pin", fallback: "PIN" },
  password: { key: "devices.verify.pin", fallback: "PIN" },
  pin: { key: "devices.verify.pin", fallback: "PIN" },
  iris: { key: "devices.verify.iris", fallback: "Iris" },
  qr: { key: "devices.verify.qr", fallback: "QR" },
};

/**
 * Turn a device verify mode into readable factors.
 *
 * ``faceOrFpOrCardOrPw`` → ``Face / Finger / Card / PIN``
 *
 * The camelCase ``Or`` / ``And`` separators are how both Hikvision and
 * Dahua compose factors, so splitting on them covers every combination
 * without a lookup table per permutation.
 */
export function verifyModeLabel(mode: string | null, t: T): string {
  if (!mode || !mode.trim()) return "—";
  const parts = mode
    .split(/Or|And/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return mode;
  return parts
    .map((raw) => {
      const known = VERIFY_FACTORS[raw.toLowerCase()];
      if (known) return t(known.key, { defaultValue: known.fallback });
      return raw.charAt(0).toUpperCase() + raw.slice(1);
    })
    .join(" / ");
}

/**
 * One-line summary of what a device is, for the sub-line under its name.
 * Only the facts we actually have — an empty location and an unlearned
 * serial should cost no vertical space.
 */
export function deviceSubtitle(parts: (string | null | undefined)[]): string {
  return parts.map((p) => (p ?? "").trim()).filter(Boolean).join(" · ");
}
