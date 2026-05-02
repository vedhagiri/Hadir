#!/usr/bin/env bash
#
# package-release.sh — build a customer-shippable Maugood release zip.
#
# What it does (in order):
#   1. Reads the current version from ``.version`` at the repo root
#      (creates it as ``0.0.0`` on first run).
#   2. Computes the new version (auto patch-bump, or --major /
#      --minor / --patch / --version X.Y.Z).
#   3. Refuses to run on a dirty working tree (so the meta file
#      records a coherent commit_id).
#   4. Updates ``.version``, ``frontend/package.json``,
#      ``backend/pyproject.toml`` with the new version.
#   5. Writes a release-history record at
#      ``release-history/v{version}.json`` carrying:
#        - version
#        - git_url (origin remote)
#        - branch
#        - commit_id (full SHA — points at the previous commit, since
#          the bump itself is committed in step 6)
#        - utc + local date/time
#        - builder hostname, OS, kernel, user, python + node versions
#   6. Commits "chore: release v{version}" (skip with --no-commit).
#   7. Builds dist/maugood-v{version}.zip via ``git archive``,
#      honouring ``.gitattributes`` export-ignore. Stamps a
#      ``RELEASE-META.json`` (the same shape as the history file)
#      and a plain ``VERSION`` file inside the zip so the customer
#      can ``cat VERSION`` to confirm what they got.
#
# **No git tag is created.** ``.version`` + the
# ``release-history/`` records are the durable trail; tags clutter
# the repo for no operational benefit on this product.
#
# Usage:
#   ./scripts/package-release.sh                 # patch bump (1.0.0 -> 1.0.1)
#   ./scripts/package-release.sh --minor         # minor bump (1.0.1 -> 1.1.0)
#   ./scripts/package-release.sh --major         # major bump (1.1.0 -> 2.0.0)
#   ./scripts/package-release.sh --version 1.5.0 # explicit
#   ./scripts/package-release.sh --no-commit     # skip the version-bump commit
#   ./scripts/package-release.sh --dry-run       # print plan, don't write
#
# The script is idempotent within a session — if anything fails
# after a partial change, it prints the recovery commands.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ---------------------------------------------------------------------------
# Args
# ---------------------------------------------------------------------------
BUMP="patch"
EXPLICIT_VERSION=""
DO_COMMIT=1
DRY_RUN=0

while [[ $# -gt 0 ]]; do
    case "$1" in
        --major)        BUMP="major"; shift ;;
        --minor)        BUMP="minor"; shift ;;
        --patch)        BUMP="patch"; shift ;;
        --version)      EXPLICIT_VERSION="$2"; shift 2 ;;
        --no-commit)    DO_COMMIT=0; shift ;;
        --dry-run)      DRY_RUN=1; shift ;;
        -h|--help)
            sed -n '3,57p' "$0"
            exit 0 ;;
        *)
            echo "error: unknown flag '$1'" >&2
            exit 2 ;;
    esac
done

# ---------------------------------------------------------------------------
# Read the current version from .version (the canonical source)
# ---------------------------------------------------------------------------
VERSION_FILE="${REPO_ROOT}/.version"
if [[ -f "${VERSION_FILE}" ]]; then
    CURRENT_VERSION="$(tr -d '[:space:]' < "${VERSION_FILE}")"
else
    CURRENT_VERSION="0.0.0"
    echo "(.version missing — assuming first release, current=0.0.0)"
fi

if ! [[ "${CURRENT_VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: .version contains '${CURRENT_VERSION}' which is not MAJOR.MINOR.PATCH" >&2
    exit 2
fi

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
M, m, p = (int(x) for x in parts)
bump = '${BUMP}'
if bump == 'major':   M, m, p = M+1, 0, 0
elif bump == 'minor': m, p    = m+1, 0
elif bump == 'patch': p       = p+1
print(f'{M}.{m}.{p}')
")"
fi

VERSION_LABEL="v${NEW_VERSION}"
ZIP_NAME="maugood-${VERSION_LABEL}.zip"
ZIP_PATH="dist/${ZIP_NAME}"
META_PATH="release-history/${VERSION_LABEL}.json"

echo "================================================================"
echo " Maugood release packager"
echo "================================================================"
echo " current version : ${CURRENT_VERSION}"
echo " new version     : ${NEW_VERSION}  (bump=${BUMP}${EXPLICIT_VERSION:+, explicit})"
echo " commit bump     : $([[ ${DO_COMMIT} -eq 1 ]] && echo 'yes' || echo 'no')"
echo " output zip      : ${ZIP_PATH}"
echo " meta record     : ${META_PATH}"
echo " dry run         : $([[ ${DRY_RUN} -eq 1 ]] && echo 'yes' || echo 'no')"
echo " git tag         : not created (durable trail = .version + release-history/)"
echo "================================================================"

# ---------------------------------------------------------------------------
# Pre-flight: clean working tree, no version regression
# ---------------------------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
    if [[ ${DO_COMMIT} -eq 1 ]]; then
        echo "error: working tree has uncommitted changes." >&2
        echo "       Commit or stash them first; the meta file records a coherent commit_id." >&2
        echo "       To bypass (you really shouldn't), pass --no-commit." >&2
        exit 1
    fi
fi

python3 - <<EOF
def parse(v): return tuple(int(x) for x in v.split('.'))
cur = parse('${CURRENT_VERSION}')
new = parse('${NEW_VERSION}')
if new <= cur and '${EXPLICIT_VERSION}' == '':
    raise SystemExit(f'computed version {new} is not greater than current {cur} — bug?')
if new < cur:
    print(f'warning: new version ${NEW_VERSION} is older than current ${CURRENT_VERSION}')
EOF

# ---------------------------------------------------------------------------
# Gather meta NOW so the recorded commit_id points at the
# pre-bump commit. The bump commit itself reflects "version X.Y.Z
# was prepared from commit Y" — easier to trace than recording the
# bump-commit's own SHA.
# ---------------------------------------------------------------------------
GIT_URL="$(git config --get remote.origin.url 2>/dev/null || echo 'unknown')"
GIT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo 'unknown')"
GIT_COMMIT_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
NOW_UTC="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_LOCAL="$(date '+%Y-%m-%d %H:%M:%S %Z')"
HOSTNAME_VAL="$(hostname 2>/dev/null || echo 'unknown')"
KERNEL_VAL="$(uname -srm 2>/dev/null || echo 'unknown')"
OS_VAL="$(uname -s 2>/dev/null || echo 'unknown')"
USER_VAL="${USER:-$(whoami 2>/dev/null || echo 'unknown')}"
PY_VERSION="$(python3 --version 2>/dev/null | awk '{print $2}' || echo 'unknown')"
NODE_VERSION="$(node --version 2>/dev/null | sed 's/^v//' || echo 'unknown')"

if [[ ${DRY_RUN} -eq 1 ]]; then
    echo
    echo "[dry-run] Would write: .version, frontend/package.json, backend/pyproject.toml"
    echo "[dry-run] Would record: ${META_PATH}"
    echo "[dry-run] Would commit: chore: release ${VERSION_LABEL}"
    echo "[dry-run] Would build:  ${ZIP_PATH} (with RELEASE-META.json + VERSION inside)"
    exit 0
fi

# ---------------------------------------------------------------------------
# Update version files
# ---------------------------------------------------------------------------
echo
echo ">> Updating version files"

# .version — the canonical source
echo "${NEW_VERSION}" > "${VERSION_FILE}"
echo "   .version                -> ${NEW_VERSION}"

python3 - <<EOF
import json, pathlib, re

# frontend/package.json
p = pathlib.Path('frontend/package.json')
data = json.loads(p.read_text())
data['version'] = '${NEW_VERSION}'
p.write_text(json.dumps(data, indent=2) + '\n')
print(f'   frontend/package.json   -> {data["version"]}')

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
print(f'   backend/pyproject.toml  -> ${NEW_VERSION}')
EOF

# ---------------------------------------------------------------------------
# Write the per-release meta record
# ---------------------------------------------------------------------------
echo
echo ">> Writing ${META_PATH}"
mkdir -p release-history
python3 - <<EOF
import json, pathlib

meta = {
    "version":        "${NEW_VERSION}",
    "label":          "${VERSION_LABEL}",
    "git_url":        "${GIT_URL}",
    "branch":         "${GIT_BRANCH}",
    "commit_id":      "${GIT_COMMIT}",
    "commit_short":   "${GIT_COMMIT_SHORT}",
    "built_at_utc":   "${NOW_UTC}",
    "built_at_local": "${NOW_LOCAL}",
    "machine": {
        "hostname":       "${HOSTNAME_VAL}",
        "os":             "${OS_VAL}",
        "kernel":         "${KERNEL_VAL}",
        "user":           "${USER_VAL}",
        "python_version": "${PY_VERSION}",
        "node_version":   "${NODE_VERSION}",
    },
}
pathlib.Path("${META_PATH}").write_text(
    json.dumps(meta, indent=2, sort_keys=False) + "\n"
)
print(f"   recorded {len(meta)} top-level keys")
EOF

# ---------------------------------------------------------------------------
# Commit
# ---------------------------------------------------------------------------
if [[ ${DO_COMMIT} -eq 1 ]]; then
    echo
    echo ">> Committing version bump"
    git add .version frontend/package.json backend/pyproject.toml "${META_PATH}"
    git commit -m "chore: release ${VERSION_LABEL}"
fi

# ---------------------------------------------------------------------------
# Build the archive
# ---------------------------------------------------------------------------
echo
echo ">> Building ${ZIP_PATH}"
mkdir -p dist

# git archive honours .gitattributes export-ignore. Use HEAD —
# we're not tagging, and committing the bump above means HEAD is
# the right snapshot to export.
git archive \
    --format=zip \
    --prefix="maugood-${VERSION_LABEL}/" \
    -o "${ZIP_PATH}" \
    HEAD

# Stamp a top-level VERSION + RELEASE-META.json inside the zip
# alongside whatever git archive produced. zip CLI is the simplest
# way to inject extra files.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
mkdir -p "${TMP_DIR}/maugood-${VERSION_LABEL}"
echo "${NEW_VERSION}" > "${TMP_DIR}/maugood-${VERSION_LABEL}/VERSION"
cp "${META_PATH}" "${TMP_DIR}/maugood-${VERSION_LABEL}/RELEASE-META.json"
(
    cd "${TMP_DIR}"
    zip -q "${REPO_ROOT}/${ZIP_PATH}" \
        "maugood-${VERSION_LABEL}/VERSION" \
        "maugood-${VERSION_LABEL}/RELEASE-META.json"
)

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
SIZE="$(du -h "${ZIP_PATH}" | cut -f1)"
ENTRIES="$(unzip -l "${ZIP_PATH}" 2>/dev/null | tail -1 | awk '{print $2}')"

echo
echo "================================================================"
echo " ✓ Built ${ZIP_PATH}  (${SIZE}, ${ENTRIES} files)"
echo "================================================================"
echo " Inside the zip:"
echo "   maugood-${VERSION_LABEL}/VERSION              (plain text)"
echo "   maugood-${VERSION_LABEL}/RELEASE-META.json    (build provenance)"
echo
echo " Repo trail:"
echo "   .version                                  -> ${NEW_VERSION}"
echo "   ${META_PATH}"
echo
echo " Next steps:"
[[ ${DO_COMMIT} -eq 1 ]] && echo "   git push                     # publish the version-bump commit"
echo "   scp ${ZIP_PATH} <client>   # ship to the customer"
echo
echo " Recovery (if anything in this run was wrong):"
[[ ${DO_COMMIT} -eq 1 ]] && echo "   git reset --hard HEAD~1      # undo the version-bump commit"
echo "   rm ${ZIP_PATH} ${META_PATH}"
