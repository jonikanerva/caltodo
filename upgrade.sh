#!/usr/bin/env bash
set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm install --lts --latest-npm --reinstall-packages-from=current
nvm use --lts
node -p "process.versions.node" > .nvmrc
corepack enable
corepack use pnpm@latest
pnpm -r update --latest
pnpm -r install
