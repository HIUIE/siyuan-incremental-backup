#!/usr/bin/env bash
# 打包思源插件（市场 zip 契约：plugin.json / index.js / index.css / i18n / icon.png / preview.png / README*）
set -euo pipefail
cd "$(dirname "$0")"

NAME=$(node -e "console.log(require('./plugin.json').name)")
VERSION=$(node -e "console.log(require('./plugin.json').version)")
OUT="${NAME}-v${VERSION}.zip"

rm -f "$OUT"
zip -r "$OUT" \
  plugin.json index.js index.css i18n icon.png preview.png \
  README.md README_zh_CN.md LICENSE -x "*.DS_Store"

echo "打包完成: $OUT"
echo "发布步骤: 在 GitHub 仓库创建 Release 并上传该 zip，然后向 siyuan-note/siyuan-index 的 plugins.json 提交 PR。"
