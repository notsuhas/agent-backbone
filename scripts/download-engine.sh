#!/bin/sh
set -eu
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64) arch=amd64 ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
case "$os/$arch" in
  darwin/arm64) sha=73f0b0b7114cf42cefda795107a06252bbb9e10751d6addb174cd8b9a5a979c7 ;;
  darwin/amd64) sha=6ca0fb91c837eaa082c325683081ad6c3e65a78bba4ff0226a77f6ef368eb2c2 ;;
  linux/arm64) sha=6d35bef34e8a34a4111a533d4fbfe3ad56a8cf67670dfb44aaef2ee3d2d454a3 ;;
  linux/amd64) sha=5bd99d0677171d619009f49464aabcb3fadd86b7e87b85eb66b40476b9cffe5e ;;
  *) echo "Unsupported platform: $os/$arch" >&2; exit 1 ;;
esac
mkdir -p vendor
curl --fail --location --silent --show-error "https://github.com/runkids/skillshare/releases/download/v0.30.8/skillshare_0.30.8_${os}_${arch}.tar.gz" -o vendor/engine.tar.gz
printf '%s  %s\n' "$sha" vendor/engine.tar.gz | shasum -a 256 -c -
tar -xzf vendor/engine.tar.gz -C vendor skillshare
