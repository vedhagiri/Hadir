# Hadir backup container (v1.0 P24).
#
# Postgres 15 client tools + tar/gzip/jq/sha256sum + supercronic
# for Docker-friendly cron. Runs ``backup.sh`` under
# supercronic; the script itself lives in the bind-mounted
# ``backend/scripts/`` directory so updates don't require an
# image rebuild.
#
# Why supercronic over native cron: BusyBox cron + Debian cron
# both swallow stdout/stderr in ways that hide failures from
# ``docker logs``. supercronic streams every line, exits
# non-zero on script failure, and respects PID 1 signal
# semantics (so ``docker stop`` is clean).

FROM postgres:15-alpine

# Install bash (for the script's set -euo pipefail), tar, gzip,
# coreutils for sha256sum (BusyBox sha256sum has tab vs space
# inconsistencies), and jq.
RUN apk add --no-cache \
        bash \
        coreutils \
        tar \
        gzip \
        jq \
        ca-certificates \
        tzdata \
        curl

# supercronic — pinned to a known-good release. Refresh on a
# security update; HTTPS + the GitHub release ASN provide the
# integrity guarantee. The release artifact is a single static
# binary so we only have to pick the right architecture suffix.
# P27: 0.2.29 → 0.2.45 (clears the 11 HIGH + 2 CRITICAL Go
# stdlib + dependency CVEs Trivy flagged on the older binary).
ARG SUPERCRONIC_VERSION=v0.2.45
RUN ARCH=$(uname -m) && case "${ARCH}" in \
        x86_64)  S=amd64 ;; \
        aarch64) S=arm64 ;; \
        *) echo "unsupported arch ${ARCH}" >&2 && exit 1 ;; \
    esac && \
    curl -fsSLo /usr/local/bin/supercronic \
        "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${S}" && \
    chmod +x /usr/local/bin/supercronic && \
    /usr/local/bin/supercronic -h >/dev/null

# AWS CLI is heavy; install the small ``aws-cli-plugin-`` shim
# only when the operator opts in via build arg. Default OFF
# so the image stays small for the local-NAS path.
ARG INCLUDE_AWS_CLI=0
RUN if [ "${INCLUDE_AWS_CLI}" = "1" ]; then \
        apk add --no-cache aws-cli; \
    fi

# Container-friendly tz support — defaults to Asia/Muscat per
# pilot but can be overridden per environment.
ENV TZ=Asia/Muscat

WORKDIR /app

COPY ops/backup/crontab /etc/supercronic/crontab
COPY ops/backup/entrypoint.sh /usr/local/bin/hadir-backup-entrypoint
RUN chmod +x /usr/local/bin/hadir-backup-entrypoint

ENTRYPOINT ["/usr/local/bin/hadir-backup-entrypoint"]
