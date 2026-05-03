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
# Compute the upgrade manifest by diffing against the previous release.
#
# The packager looks back through ``release-history/*.json`` for the
# most recent record whose ``version`` is strictly less than the one
# we're cutting now, reads its ``commit_id``, then runs
# ``git diff --name-only <prev_commit>..HEAD`` to bucket changed files
# into a small fixed schema the update flow consumes verbatim:
#
#   - new_migrations             : paths under backend/alembic/versions/
#   - services_changed.backend   : any path under backend/ (sans alembic)
#   - services_changed.frontend  : any path under frontend/ (sans node_modules/dist)
#   - services_changed.nginx     : any path under ops/nginx/
#   - services_changed.postgres  : currently always false (we never
#                                  mutate the postgres image; left as
#                                  a slot so the schema is stable)
#   - compose_changed            : docker-compose.yml touched
#   - https_compose_changed      : docker-compose-https-local.yaml touched
#   - env_keys_added/removed     : diff of ``MAUGOOD_*`` keys in any
#                                  .env.example file
#   - upgrade_scripts            : backend/scripts/upgrade-*.py touched
#
# First-release fallback: if no prior release-history record exists,
# every bucket is "true" and ``previous_version`` is null. The update
# script treats null-prev as "fresh install — apply everything."
# ---------------------------------------------------------------------------
PREV_VERSION=""
PREV_COMMIT=""

# Find the most recent release-history record with a version strictly
# less than ${NEW_VERSION}. We'd just sort filenames but ``v1.1.10``
# sorts before ``v1.1.9`` lexically — use Python's split-by-dots
# tuple comparison instead.
if [[ -d release-history ]]; then
    PREV_INFO="$(python3 - "${NEW_VERSION}" <<'PY'
import json, pathlib, sys
target = tuple(int(x) for x in sys.argv[1].split('.'))
best = None
for p in sorted(pathlib.Path("release-history").glob("v*.json")):
    try:
        data = json.loads(p.read_text())
        v = tuple(int(x) for x in data.get("version", "0.0.0").split("."))
    except Exception:
        continue
    if v < target and (best is None or v > best[0]):
        best = (v, data.get("commit_id", ""), data.get("version", ""))
if best is None:
    print("|")
else:
    print(f"{best[2]}|{best[1]}")
PY
)"
    PREV_VERSION="${PREV_INFO%%|*}"
    PREV_COMMIT="${PREV_INFO##*|}"
fi

CHANGED_FILES_ARGS=()
if [[ -n "${PREV_COMMIT}" ]]; then
    # Use HEAD~1 if --no-commit (HEAD is still pre-bump) — we want
    # the diff to cover the actual code being shipped. With the
    # default --commit path, HEAD IS the bump commit, but the bump
    # only touches version files (no functional change), so the
    # diff <prev_commit>..HEAD is what we want.
    CHANGED_FILES_ARGS=( "${PREV_COMMIT}..HEAD" )
fi

CHANGED_FILES=""
if [[ ${#CHANGED_FILES_ARGS[@]} -gt 0 ]]; then
    # Use a here-string so an empty diff doesn't blow up on set -e.
    CHANGED_FILES="$(git diff --name-only "${CHANGED_FILES_ARGS[@]}" 2>/dev/null || true)"
fi

MANIFEST_PATH="release-history/${VERSION_LABEL}-manifest.json"

echo
echo ">> Writing ${MANIFEST_PATH}"
mkdir -p release-history
python3 - <<EOF
import json, pathlib, re

# Inputs from shell ---------------------------------------------------------
new_version = "${NEW_VERSION}"
prev_version = "${PREV_VERSION}" or None
prev_commit = "${PREV_COMMIT}" or None
new_commit = "${GIT_COMMIT}"
changed = """${CHANGED_FILES}""".strip().splitlines()

# When there's no previous version, treat everything as "changed"
# from a fresh install. We don't try to enumerate every file in the
# tree — empty diff with prev=null is the signal.
all_new = prev_commit is None

# Bucket the changed file list ---------------------------------------------
def under(prefix, path):
    return path == prefix or path.startswith(prefix + "/")

new_migrations = sorted({
    pathlib.Path(p).name
    for p in changed
    if under("backend/alembic/versions", p) and p.endswith(".py")
})

backend_changed = any(
    under("backend", p)
    and not under("backend/alembic/versions", p)
    and not under("backend/scripts/upgrade-", p)  # upgrade scripts are tracked separately
    for p in changed
)
frontend_changed = any(
    under("frontend", p)
    and not under("frontend/node_modules", p)
    and not under("frontend/dist", p)
    for p in changed
)
nginx_changed = any(under("ops/nginx", p) for p in changed)
compose_changed = any(p == "docker-compose.yml" for p in changed)
https_compose_changed = any(p == "docker-compose-https-local.yaml" for p in changed)

# .env.example diff: collect MAUGOOD_* keys from current files,
# parse the previous-version copy from git, diff sets.
env_files = ["backend/.env.example", "frontend/.env.example", ".env.example"]
def env_keys_at(rev, file):
    import subprocess
    try:
        out = subprocess.check_output(
            ["git", "show", f"{rev}:{file}"], stderr=subprocess.DEVNULL
        ).decode()
    except subprocess.CalledProcessError:
        return set()
    keys = set()
    for line in out.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([A-Z][A-Z0-9_]*)=", line)
        if m and m.group(1).startswith("MAUGOOD_"):
            keys.add(m.group(1))
    return keys

env_keys_added = []
env_keys_removed = []
if prev_commit:
    new_keys = set()
    old_keys = set()
    for f in env_files:
        new_keys |= env_keys_at(new_commit, f)
        old_keys |= env_keys_at(prev_commit, f)
    env_keys_added = sorted(new_keys - old_keys)
    env_keys_removed = sorted(old_keys - new_keys)

# Upgrade scripts — by convention backend/scripts/upgrade-*.py
upgrade_scripts = sorted({
    p
    for p in changed
    if under("backend/scripts", p)
    and pathlib.Path(p).name.startswith("upgrade-")
    and p.endswith(".py")
})

# All-new fallback ---------------------------------------------------------
if all_new:
    backend_changed = True
    frontend_changed = True
    nginx_changed = True
    compose_changed = True
    https_compose_changed = True

manifest = {
    "version": new_version,
    "previous_version": prev_version,
    "commit_id": new_commit,
    "previous_commit_id": prev_commit,
    "all_new_install": all_new,
    "new_migrations": new_migrations,
    "services_changed": {
        "backend":  backend_changed,
        "frontend": frontend_changed,
        "nginx":    nginx_changed,
        "postgres": False,  # we never mutate the postgres image
    },
    "compose_changed":       compose_changed,
    "https_compose_changed": https_compose_changed,
    "env_keys_added":   env_keys_added,
    "env_keys_removed": env_keys_removed,
    "upgrade_scripts":  upgrade_scripts,
}
pathlib.Path("${MANIFEST_PATH}").write_text(
    json.dumps(manifest, indent=2, sort_keys=False) + "\n"
)
print(f"   prev version       : {prev_version}")
print(f"   new migrations     : {len(new_migrations)}")
print(f"   services changed   : "
      f"{'B' if backend_changed else '-'}"
      f"{'F' if frontend_changed else '-'}"
      f"{'N' if nginx_changed else '-'}")
print(f"   env keys added/rem : {len(env_keys_added)}/{len(env_keys_removed)}")
print(f"   upgrade scripts    : {len(upgrade_scripts)}")
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
    git add .version frontend/package.json backend/pyproject.toml \
        "${META_PATH}" "${MANIFEST_PATH}"
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

# Stamp a top-level VERSION + RELEASE-META.json + RELEASE-MANIFEST.json
# inside the zip alongside whatever git archive produced. The
# manifest is what update-time tooling reads to decide which
# services need rebuilding, whether migrations apply, etc.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT
mkdir -p "${TMP_DIR}/maugood-${VERSION_LABEL}"
echo "${NEW_VERSION}" > "${TMP_DIR}/maugood-${VERSION_LABEL}/VERSION"
cp "${META_PATH}" "${TMP_DIR}/maugood-${VERSION_LABEL}/RELEASE-META.json"
cp "${MANIFEST_PATH}" "${TMP_DIR}/maugood-${VERSION_LABEL}/RELEASE-MANIFEST.json"
(
    cd "${TMP_DIR}"
    zip -q "${REPO_ROOT}/${ZIP_PATH}" \
        "maugood-${VERSION_LABEL}/VERSION" \
        "maugood-${VERSION_LABEL}/RELEASE-META.json" \
        "maugood-${VERSION_LABEL}/RELEASE-MANIFEST.json"
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
echo "   maugood-${VERSION_LABEL}/VERSION                  (plain text)"
echo "   maugood-${VERSION_LABEL}/RELEASE-META.json        (build provenance)"
echo "   maugood-${VERSION_LABEL}/RELEASE-MANIFEST.json    (upgrade plan input)"
echo
echo " Repo trail:"
echo "   .version                                  -> ${NEW_VERSION}"
echo "   ${META_PATH}"
echo "   ${MANIFEST_PATH}"
echo
echo " Next steps:"
[[ ${DO_COMMIT} -eq 1 ]] && echo "   git push                     # publish the version-bump commit"
echo "   scp ${ZIP_PATH} <client>   # ship to the customer"
echo
echo " Recovery (if anything in this run was wrong):"
[[ ${DO_COMMIT} -eq 1 ]] && echo "   git reset --hard HEAD~1      # undo the version-bump commit"
echo "   rm ${ZIP_PATH} ${META_PATH}"
