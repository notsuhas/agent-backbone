#!/bin/sh
set -eu
TASK_ENGINE_OS=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  arm64|aarch64) TASK_ENGINE_ARCH=arm64 ;;
  x86_64) TASK_ENGINE_ARCH=amd64 ;;
  *) exit 1 ;;
esac
case "$TASK_ENGINE_OS/$TASK_ENGINE_ARCH" in
  darwin/arm64) TASK_ENGINE_SHA=4e7bec76c49fea9cacef3076cc7b668262ca3655eac3583872f870d2dc4fc496 ;;
  darwin/amd64) TASK_ENGINE_SHA=783903b2d6e7e357678a7ac9a61bf10e673cc572aa2c1b1619b17fe02258ea0d ;;
  linux/arm64) TASK_ENGINE_SHA=562e8f8ebd06df200e1e56266cdad3822781d183ae6696d7b09e37b2e6003994 ;;
  linux/amd64) TASK_ENGINE_SHA=2ae0f8fce4ecd79be6ff44cc6423d03fbd80ac89b825104bae1afc9580a66b5d ;;
  *) exit 1 ;;
esac
mkdir -p vendor
curl --fail --location --silent --show-error "https://github.com/runkids/skillshare/releases/download/v0.25.11/skillshare_0.25.11_${TASK_ENGINE_OS}_${TASK_ENGINE_ARCH}.tar.gz" -o vendor/engine.tar.gz
printf '%s  %s\n' "$TASK_ENGINE_SHA" vendor/engine.tar.gz | shasum -a 256 -c -
tar -xzf vendor/engine.tar.gz -C vendor skillshare
