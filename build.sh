#!/usr/bin/env bash
# 使用 Node 标准库准备单文件入口，再按思源集市约定生成 ZIP。
set -euo pipefail
node "$(dirname "$0")/build-package.js"
