# Maugood nginx image (v1.0 P23).
#
# Multi-stage:
#   1. node builder produces the production frontend bundle
#      (``vite build``).
#   2. nginx serves the bundle on / and proxies /api/* to the
#      backend over the internal docker network. envsubst (from
#      gettext) renders ``maugood.conf.template`` at boot using
#      operator-supplied env vars.
#
# Build context is the repo root so the builder can ``COPY
# frontend/`` directly. See ``docker-compose.prod.yml``.

# --- 1. frontend bundle -------------------------------------------------
FROM node:20-alpine AS frontend-build
WORKDIR /build

# Install deps first so this layer caches when source changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

# --- 2. nginx ----------------------------------------------------------
# P27: bumped from ``nginx:1.27-alpine`` (alpine 3.21.3, 28 HIGH +
# 6 CRITICAL OS CVEs per Trivy) to ``nginx:stable-alpine``
# (alpine 3.23.4, 0 HIGH/CRITICAL) — same nginx feature set,
# fresher base.
FROM nginx:stable-alpine

RUN apk add --no-cache gettext

COPY ops/nginx/maugood.conf.template /etc/nginx/templates/maugood.conf.template
COPY ops/nginx/entrypoint.sh /docker-entrypoint.d/99-maugood.sh
RUN chmod +x /docker-entrypoint.d/99-maugood.sh

# Frontend bundle from stage 1. The path matches the ``root``
# directive in ``maugood.conf.template``.
COPY --from=frontend-build /build/dist /usr/share/nginx/html

# Replace the base image's command with our entrypoint so it
# renders the templated config + execs nginx itself. The
# ``/docker-entrypoint.d/`` placement keeps compatibility with
# the upstream image's other init scripts (TLS bootstrap, etc.).
ENTRYPOINT ["/docker-entrypoint.d/99-maugood.sh"]
