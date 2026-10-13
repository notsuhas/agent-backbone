#!/bin/sh
set -eu
TASK_ENGINE_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64|aarch64) TASK_ENGINE_ARCH=arm64 ;;
  x86_64) TASK_ENGINE_ARCH=amd64 ;;
  *) exit 1 ;;
esac
case "$TASK_ENGINE_OS/$TASK_ENGINE_ARCH" in
  darwin/arm64) TASK_ENGINE_SHA=1f6ada0546d4007d6520fb063e8f2dcb00f3e1833a26845ed7a96f8f59cfd46f ;;
  darwin/amd64) TASK_ENGINE_SHA=399a2e82d08423080c4cf797ff68e566b08c4e6ed3d42c5d34af4b02dc8ac7fb ;;
  linux/arm64) TASK_ENGINE_SHA=323544db97a37a59969f29c9c1a87fa0278939ae7d40c92e4e5f28c55ca10060 ;;
  linux/amd64) TASK_ENGINE_SHA=ce2220d8a32e01ae319dda4a3ce8db10e90a5c9fd67fc2a0995d4e6e40e50d29 ;;
  *) exit 1 ;;
esac
mkdir -p vendor
curl --fail --location --silent --show-error "https://github.com/runkids/skillshare/releases/download/v0.25.10/skillshare_0.25.10_${TASK_ENGINE_OS}_${TASK_ENGINE_ARCH}.tar.gz" -o vendor/engine.tar.gz
printf '%s  %s\n' "$TASK_ENGINE_SHA" vendor/engine.tar.gz | shasum -a 256 -c -
tar -xzf vendor/engine.tar.gz -C vendor skillshare
