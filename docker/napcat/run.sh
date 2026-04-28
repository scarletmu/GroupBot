#!/usr/bin/env bash
# Start the local NapCat debug container. Single service, single command.
# Re-run is safe: existing container is removed first.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p data/qq data/config data/plugins

docker rm -f qqbot-napcat >/dev/null 2>&1 || true

exec docker run -d \
  --name qqbot-napcat \
  --restart unless-stopped \
  -e NAPCAT_UID="$(id -u)" \
  -e NAPCAT_GID="$(id -g)" \
  -p 16099:6099 \
  -p 13000:3000 \
  -p 13001:3001 \
  --add-host=host.docker.internal:host-gateway \
  -v "$PWD/data/qq:/app/.config/QQ" \
  -v "$PWD/data/config:/app/napcat/config" \
  -v "$PWD/data/plugins:/app/napcat/plugins" \
  mlikiowa/napcat-docker:latest
