#!/usr/bin/env bash
#
# package-release.sh — build a customer-shippable Maugood release zip.
#
# What it does:
#   1. Reads the current version from frontend/package.json.
#   2. Computes the new version (auto patch-bump by default, or
#      --major / --minor / --patch / --version X.Y.Z).
#   3. Refuses to run on a dirty working tree (so the tag points at
#      a coherent snapshot).
#   4. Updates frontend/package.json + backend/pyproject.toml with
#      the new version.
#   5. Commits "chore: release vX.Y.Z" (skip with --no-commit).
#   6. Creates an annotated git tag vX.Y.Z (skip with --no-tag).
#   7. Builds dist/maugood-vX.Y.Z.zip via `git archive`, using the
#      .gitattributes export-ignore rules to skip docs / design
#      archive / tests / dev-only scripts / etc.
#
# Usage:
#   ./scripts/package-release.sh                  # patch bump (1.0.0 -> 1.0.1)
#   ./scripts/package-release.sh --minor          # minor bump (1.0.1 -> 1.1.0)
#   ./scripts/package-release.sh --major          # major bump (1.1.0 -> 2.0.0)
#   ./scripts/package-release.sh --version 1.5.0  # explicit
#   ./scripts/package-release.sh --no-tag         # skip git tag
#   ./scripts/package-release.sh --no-commit      # skip version-bump commit
#   ./scripts/package-release.sh --dry-run        # print plan, don't write
#
# The script is idempotent within a session — if anything fails after
# a partial change, it prints the recovery commands. Run from the
# repo root or any subdirectory.

set -euo pipefail

# ---------------------------------------------------------------------------
# Resolve repo root
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Parse args
# ---------------------------------------------------------------------------
BUMP="patch"
EXPLICIT_VERSION=""
DO_TAG=1
DO_COMMIT=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --major)        BUMP="major"; shift ;;
        --minor)        BUMP="minor"; shift ;;
        --patch)        BUMP="patch"; shift ;;
        --version)      EXPLICIT_VERSION="$2"; shift 2 ;;
        --no-tag)       DO_TAG=0; shift ;;
        --no-commit)    DO_COMMIT=0; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '3,30p' "$0"
            exit 0 ;;
        *)
            echo "error: unknown flag '$1'" >&2
            exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Read current version
# ---------------------------------------------------------------------------
CURRENT_VERSION="$(python3 -c "
import json, pathlib
p = pathlib.Path('frontend/package.json')
print(json.loads(p.read_text())['version'])
")"

# ---------------------------------------------------------------------------
# Compute new version
# ---------------------------------------------------------------------------
if [[ -n "${EXPLICIT_VERSION}" ]]; then
    NEW_VERSION="${EXPLICIT_VERSION}"
    if ! [[ "${NEW_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "error: --version must be MAJOR.MINOR.PATCH (got '${NEW_VERSION}')" >&2
        exit 2
    fi
else
    NEW_VERSION="$(python3 -c "
parts = '${CURRENT_VERSION}'.split('.')
if len(parts) != 3 or not all(p.isdigit() for p in parts):
    raise SystemExit(f'cannot bump non-semver version: ${CURRENT_VERSION}')
M, m, p = (int(x) for x in parts)
bump = '${BUMP}'
if bump == 'major':   M, m, p = M+1, 0, 0
elif bump == 'minor': m, p    = m+1, 0
elif bump == 'patch': p       = p+1
print(f'{M}.{m}.{p}')
")"
fi

TAG="v${NEW_VERSION}"
ZIP_NAME="maugood-${TAG}.zip"
ZIP_PATH="dist/${ZIP_NAME}"

echo "================================================================"
echo " Maugood release packager"
echo "================================================================"
echo " current version  : ${CURRENT_VERSION}"
echo " new version      : ${NEW_VERSION}  (bump=${BUMP}${EXPLICIT_VERSION:+, explicit})"
echo " git tag          : ${TAG}$([[ ${DO_TAG} -eq 0 ]] && echo '  (skipped)')"
echo " commit version   : $([[ ${DO_COMMIT} -eq 1 ]] && echo 'yes' || echo 'no')"
echo " output           : ${ZIP_PATH}"
echo " dry run          : $([[ ${DRY_RUN} -eq 1 ]] && echo 'yes' || echo 'no')"
echo "================================================================"

# ---------------------------------------------------------------------------
# Pre-flight: clean working tree, no existing tag, no version regression
# ---------------------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
    if [[ ${DO_COMMIT} -eq 1 ]]; then
        echo "error: working tree has uncommitted changes." >&2
        echo "       Commit or stash them first; releases need a clean tree" >&2
        echo "       so the tag points at a coherent snapshot." >&2
        echo "       To bypass (you really shouldn't), pass --no-commit." >&2
        exit 1
    fi
fi

if [[ ${DO_TAG} -eq 1 ]] && git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
    echo "error: tag ${TAG} already exists." >&2
    echo "       Delete it (\`git tag -d ${TAG}\`) or pick a different version." >&2
    exit 1
fi

# Refuse to go backwards (unless explicit override)
python3 - <<EOF
def parse(v): return tuple(int(x) for x in v.split('.'))
cur = parse('${CURRENT_VERSION}')
new = parse('${NEW_VERSION}')
if new <= cur and '${EXPLICIT_VERSION}' == '':
    raise SystemExit(f'computed version {new} is not greater than current {cur} — bug?')
if new < cur:
    print(f'warning: new version ${NEW_VERSION} is older than current ${CURRENT_VERSION}')
EOF

if [[ ${DRY_RUN} -eq 1 ]]; then
    echo
    echo "[dry-run] Would write: frontend/package.json, backend/pyproject.toml"
    echo "[dry-run] Would commit: chore: release ${TAG}"
    [[ ${DO_TAG} -eq 1 ]]    && echo "[dry-run] Would tag:    ${TAG}"
    echo "[dry-run] Would build:  ${ZIP_PATH}"
    exit 0
fi

# ---------------------------------------------------------------------------
# Update version files
# ---------------------------------------------------------------------------
echo
echo ">> Updating version files"

python3 - <<EOF
import json, pathlib, re

# frontend/package.json
p = pathlib.Path('frontend/package.json')
data = json.loads(p.read_text())
data['version'] = '${NEW_VERSION}'
p.write_text(json.dumps(data, indent=2) + '\n')
print(f'   frontend/package.json -> {data["version"]}')

# backend/pyproject.toml — keep it simple, no toml lib needed
p = pathlib.Path('backend/pyproject.toml')
text = p.read_text()
new_text, n = re.subn(
    r'^version = "[^"]+"',
    f'version = "${NEW_VERSION}"',
    text,
    count=1,
    flags=re.MULTILINE,
)
if n != 1:
    raise SystemExit('could not bump backend/pyproject.toml version')
p.write_text(new_text)
print(f'   backend/pyproject.toml -> ${NEW_VERSION}')
EOF

# ---------------------------------------------------------------------------
# Commit + tag
# ---------------------------------------------------------------------------
if [[ ${DO_COMMIT} -eq 1 ]]; then
    echo
    echo ">> Committing version bump"
    git add frontend/package.json backend/pyproject.toml
    git commit -m "chore: release ${TAG}"
fi

if [[ ${DO_TAG} -eq 1 ]]; then
    echo
    echo ">> Tagging ${TAG}"
    git tag -a "${TAG}" -m "Maugood ${TAG}"
fi

# ---------------------------------------------------------------------------
# Build the archive
# ---------------------------------------------------------------------------
echo
echo ">> Building ${ZIP_PATH}"
mkdir -p dist

# Archive from the just-tagged commit if we tagged, else HEAD.
ARCHIVE_REF="HEAD"
if [[ ${DO_TAG} -eq 1 ]]; then
    ARCHIVE_REF="${TAG}"
fi

# `git archive` honours .gitattributes export-ignore. The --prefix
# nests every entry inside a versioned top-level dir so the customer
# unzips cleanly into their working directory.
git archive \
    --format=zip \
    --prefix="maugood-${TAG}/" \
    -o "${ZIP_PATH}" \
    "${ARCHIVE_REF}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
SIZE="$(du -h "${ZIP_PATH}" | cut -f1)"
ENTRIES="$(unzip -l "${ZIP_PATH}" 2>/dev/null | tail -1 | awk '{print $2}')"

echo
echo "================================================================"
echo " ✓ Built ${ZIP_PATH}  (${SIZE}, ${ENTRIES} files)"
echo "================================================================"
echo " Next steps:"
[[ ${DO_TAG} -eq 1 ]] && echo "   git push origin ${TAG}        # publish the tag"
[[ ${DO_COMMIT} -eq 1 ]] && echo "   git push                       # publish the version-bump commit"
echo "   scp ${ZIP_PATH} <client>     # ship to the customer"
echo
echo " Recovery (if anything in this run was wrong):"
[[ ${DO_TAG} -eq 1 ]]    && echo "   git tag -d ${TAG}"
[[ ${DO_COMMIT} -eq 1 ]] && echo "   git reset --hard HEAD~1        # undo the version-bump commit"
echo "   rm ${ZIP_PATH}"
