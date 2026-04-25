#!/bin/sh
# nginx entrypoint (v1.0 P23).
#
# Renders the templated hadir.conf with envsubst, then execs
# nginx in the foreground. The template references three
# variables; sensible defaults let the container run with
# nothing but ``HADIR_PUBLIC_HOSTNAME`` set.
set -eu

: "${HADIR_PUBLIC_HOSTNAME:?HADIR_PUBLIC_HOSTNAME must be set (e.g. hadir.example.com)}"
: "${HADIR_TLS_CERT:=/etc/nginx/certs/fullchain.pem}"
: "${HADIR_TLS_KEY:=/etc/nginx/certs/privkey.pem}"

if [ ! -f "${HADIR_TLS_CERT}" ]; then
    echo "fatal: TLS cert missing at ${HADIR_TLS_CERT}" >&2
    echo "       generate one or place an operator-provided cert there." >&2
    exit 2
fi
if [ ! -f "${HADIR_TLS_KEY}" ]; then
    echo "fatal: TLS key missing at ${HADIR_TLS_KEY}" >&2
    exit 2
fi

export HADIR_PUBLIC_HOSTNAME HADIR_TLS_CERT HADIR_TLS_KEY

# Render only the variables we actually use; envsubst would
# otherwise eat any literal ``$variable`` in the rest of the
# template.
envsubst '${HADIR_PUBLIC_HOSTNAME} ${HADIR_TLS_CERT} ${HADIR_TLS_KEY}' \
    < /etc/nginx/templates/hadir.conf.template \
    > /etc/nginx/conf.d/hadir.conf

# Validate the rendered config before exec. Catches missing
# certs, syntax errors, etc. before nginx silently 502s.
nginx -t

exec nginx -g 'daemon off;'
