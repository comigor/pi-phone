#!/bin/sh
set -eu

mkdir -p /data
chown -R node:node /data
exec runuser -u node -- "$@"
