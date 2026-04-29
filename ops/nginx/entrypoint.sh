#!/bin/sh
# nginx entrypoint (v1.0 P23).
#
# Renders the templated maugood.conf with envsubst, then execs
# nginx in the foreground. The template references three
# variables; sensible defaults let the container run with
# nothing but ``MAUGOOD_PUBLIC_HOSTNAME`` set.
set -eu

: "${MAUGOOD_PUBLIC_HOSTNAME:?MAUGOOD_PUBLIC_HOSTNAME must be set (e.g. maugood.example.com)}"
: "${MAUGOOD_TLS_CERT:=/etc/nginx/certs/fullchain.pem}"
: "${MAUGOOD_TLS_KEY:=/etc/nginx/certs/privkey.pem}"

if [ ! -f "${MAUGOOD_TLS_CERT}" ]; then
    echo "fatal: TLS cert missing at ${MAUGOOD_TLS_CERT}" >&2
    echo "       generate one or place an operator-provided cert there." >&2
    exit 2
fi
if [ ! -f "${MAUGOOD_TLS_KEY}" ]; then
    echo "fatal: TLS key missing at ${MAUGOOD_TLS_KEY}" >&2
    exit 2
fi

export MAUGOOD_PUBLIC_HOSTNAME MAUGOOD_TLS_CERT MAUGOOD_TLS_KEY

# Render only the variables we actually use; envsubst would
# otherwise eat any literal ``$variable`` in the rest of the
# template.
envsubst '${MAUGOOD_PUBLIC_HOSTNAME} ${MAUGOOD_TLS_CERT} ${MAUGOOD_TLS_KEY}' \
    < /etc/nginx/templates/maugood.conf.template \
    > /etc/nginx/conf.d/maugood.conf

# Validate the rendered config before exec. Catches missing
# certs, syntax errors, etc. before nginx silently 502s.
nginx -t

exec nginx -g 'daemon off;'
