#!/bin/sh
# 一次性启用仓库内钩子（`git config core.hooksPath .githooks`）。
# 不放进 `prepare` 生命周期钩子：`npm install` 会跑它，而 CI 里改 git 配置是副作用。
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
chmod +x .githooks/pre-commit 2>/dev/null || true
echo "[hooks] core.hooksPath = .githooks；pre-commit 已启用"
