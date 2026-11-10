#!/usr/bin/env bash
# Source this to put the pinned Emscripten (emcc etc.) on PATH.
# Installs emsdk into engine/.emsdk on first use.
#   source engine/scripts/emsdk-env.sh

_ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$_ENGINE_DIR/versions.env"
_EMSDK="$_ENGINE_DIR/.emsdk"

if [ ! -d "$_EMSDK" ]; then
    git clone https://github.com/emscripten-core/emsdk.git "$_EMSDK"
fi
if ! grep -q "$EMSDK_VERSION" "$_EMSDK/.emscripten_version_activated" 2>/dev/null; then
    ( cd "$_EMSDK" && ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION" ) \
        && echo "$EMSDK_VERSION" > "$_EMSDK/.emscripten_version_activated"
fi
# shellcheck disable=SC1091
source "$_EMSDK/emsdk_env.sh" > /dev/null 2>&1
