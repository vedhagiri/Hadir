// Shared client-side validation for employee reference images.
//
// Every place a reference photo can be added — the Employee Edit drawer,
// Bulk Photo Upload, My Profile, and the Unidentified Faces "map as
// reference" flow — runs these same rules so the behaviour and messages
// are identical. This is a UX guard only; the backend
// (maugood/employees/photos.py) is authoritative and re-enforces all of
// it. Keep the constants + messages in sync with the backend.

export const MAX_REFERENCE_PHOTOS = 10;

// Per-file size cap. Mirrors the backend ``MAUGOOD_EMPLOYEE_PHOTO_MAX_MB``
// (default 10). The backend rejects anything larger regardless of this.
export const MAX_PHOTO_MB = 10;
const MAX_PHOTO_BYTES = MAX_PHOTO_MB * 1024 * 1024;

const ALLOWED_EXT = /\.(jpe?g|png|webp)$/i;
const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const PHOTO_MESSAGES = {
  maxImages:
    `Maximum ${MAX_REFERENCE_PHOTOS} reference images are allowed per ` +
    "employee. Please remove an existing image before uploading a new one.",
  badType:
    "Invalid file type. Only JPG, JPEG, PNG, and WEBP images are allowed.",
  tooLarge: `File size exceeds the maximum allowed limit of ${MAX_PHOTO_MB} MB.`,
  duplicate: "This image has already been selected.",
} as const;

export interface PhotoValidationResult {
  /** Files that passed every rule and may be uploaded. */
  valid: File[];
  /** Distinct, human-readable validation messages to surface. */
  errors: string[];
}

function isAllowedType(file: File): boolean {
  return ALLOWED_MIME.has(file.type) || ALLOWED_EXT.test(file.name);
}

/** Remaining reference-image slots for an employee (never negative). */
export function referencePhotosRemaining(currentCount: number): number {
  return Math.max(0, MAX_REFERENCE_PHOTOS - currentCount);
}

/**
 * Type + size + in-batch-duplicate validation, WITHOUT the per-employee
 * count cap. Used by Bulk Photo Upload, where one batch maps to many
 * employees by filename so the count can't be enforced client-side (the
 * backend enforces it per employee).
 */
export function validatePhotoFilesBasic(files: File[]): PhotoValidationResult {
  const errors = new Set<string>();
  const valid: File[] = [];
  const seen = new Set<string>();

  for (const f of files) {
    if (!isAllowedType(f)) {
      errors.add(PHOTO_MESSAGES.badType);
      continue;
    }
    if (f.size > MAX_PHOTO_BYTES) {
      errors.add(PHOTO_MESSAGES.tooLarge);
      continue;
    }
    const signature = `${f.name}:${f.size}`;
    if (seen.has(signature)) {
      errors.add(PHOTO_MESSAGES.duplicate);
      continue;
    }
    seen.add(signature);
    valid.push(f);
  }

  return { valid, errors: Array.from(errors) };
}

/**
 * Validate a batch of picked files against the reference-image rules.
 *
 * ``currentCount`` is how many reference images the employee already has,
 * so the count cap accounts for the existing set plus this batch. Returns
 * the accepted files and a de-duplicated list of error messages.
 */
export function validateReferencePhotos(
  files: File[],
  currentCount: number,
): PhotoValidationResult {
  const basic = validatePhotoFilesBasic(files);
  const errors = new Set(basic.errors);
  const valid: File[] = [];
  const remaining = referencePhotosRemaining(currentCount);

  for (const f of basic.valid) {
    if (valid.length >= remaining) {
      errors.add(PHOTO_MESSAGES.maxImages);
      continue;
    }
    valid.push(f);
  }

  return { valid, errors: Array.from(errors) };
}
