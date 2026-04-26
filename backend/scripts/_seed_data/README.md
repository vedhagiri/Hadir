# `_seed_data/` — assets the pre-Omran reset+seed script reads

This directory ships fixtures used by
`backend/scripts/pre_omran_reset_seed.py` (the pre-Omran
validation script) and by Suresh's manual exercises.

## What's here

* `employees_demo_sample.xlsx` — five-row sample import file
  matching the P5 employee-import schema. Suresh uses this on
  the demo tenant to exercise the import flow without hand-
  writing rows. Column shape:
  `employee_code | full_name | email | department_code`.
* `sample_photos/` — **intentionally empty** (a `.gitkeep`
  marker keeps the dir under source control). Drop real face
  photos here to enroll employees.

## Why no fake face photos

The InsightFace `buffalo_l` recognition model produces 512-
dim embeddings from real face crops. Synthetic noise
("randomly-generated face PNG") yields a vector that doesn't
match anything meaningful — the matcher silently rejects it
below the configured threshold and the operator gets a false
sense of "everything's wired correctly."

For the pre-Omran validation:

1. Drop a real photo of yourself (or any willing teammate)
   in `sample_photos/` named `<EMPLOYEE_CODE>.jpg` or
   `<EMPLOYEE_CODE>_front.jpg` — any of the angle variants
   the bulk-upload path recognises (front / left / right /
   other; bare code defaults to front).
2. Upload via Employees → click the employee → drag-drop
   into the photo zone. The P6 ingest path Fernet-encrypts
   the bytes before they hit disk.
3. Walk past the office camera. Camera Logs should show an
   identification with confidence > 0.45 within ~5 seconds.

## Operational notes

* Anything under `sample_photos/*.jpg` (and other image
  extensions) is gitignored at the repo root — see
  `.gitignore`. Do not commit real faces.
* The Excel sample IS committed because operators want a
  reference to copy from. Five fictional names + the demo
  tenant's department codes (`ENG`, `OPS`).
* If a future seed scenario needs additional non-image
  fixtures (e.g. a sample CSV for a feature that lands
  later), drop them here under a descriptive name and
  document the consumer.
