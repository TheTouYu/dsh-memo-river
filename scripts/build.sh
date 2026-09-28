#!/bin/bash
# 构建 @dsh-external/dsh-memo-river：用与运行中 DSH 一致的类型，把 src/ 编译到 lib/。
#
# 依赖解析策略（按优先级）：
#   1. **已安装的 npm 布局**（本机实际运行形态，也是本文件的默认选择）：
#        <dsh>/node_modules/@deepseek-ai/dsh-*      直接就是包目录
#        <dsh>/node_modules/@deepseek-ai/{cordis,cosmokit,schemastery}
#      ——源码里 import 'cordis' / 'schemastery' 是**路径**解析，junctions 用安装名即可
#        （Node 按目录解析，不校验 package.json 的 name 字段；这样运行期也能解析）。
#   2. DSH 源码 checkout（DSH_CHECKOUT 或常见路径）：packages/ + vendor/ 布局 —— 仅当
#      找不到已安装的 dsh 时兜底。
#   两者都会在插件自身 node_modules 下建 junction：既供 tsc 取类型，
#   也供运行期 Node 解析 `schemastery` 这类**真实运行期依赖**（type-only 导入会被擦除）。
#
# 为什么「已安装」优先于「checkout」：本插件运行在**已安装的那个 dsh** 里，
# 类型的来源必须与运行期的来源同一份，否则出现了只在编译期成立的签名漂移
# （典型：checkout 有、运行期没有的 seam 会被 tsc 放行，运行期才炸）。
# 注入器 dev_build_plugin 会带着它探测到的 DSH_CHECKOUT 调本脚本，故这里显式忽略
# 该变量对**布局选择**的影响——它仍可用于 tsc 定位。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ═══ 1. 定位 DSH 安装根 ═══
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi

# 已安装布局优先（见上文理由）。npm i -g 装到 ~/.local 时 dsh 是符号链接，
# command -v 只给链接所在目录——readlink -f 解析真实 bin 路径再回退两级才是包根。
DSH_BIN_REAL="$(readlink -f "$(command -v dsh)" 2>/dev/null || true)"
DSH_PKG_REAL=""
if [ -n "$DSH_BIN_REAL" ]; then
  DSH_PKG_REAL="$(cd "$(dirname "$DSH_BIN_REAL")/.." 2>/dev/null && pwd || true)"
fi
INSTALLED=""
for candidate in \
  "$(command -v dsh >/dev/null 2>&1 && cd "$(dirname "$(command -v dsh)")" && pwd)/node_modules/@deepseek-ai/dsh" \
  "$DSH_PKG_REAL" \
  "$(npm root -g 2>/dev/null || true)/@deepseek-ai/dsh" \
  "$HOME/.npm-dlabal/lib/node_modules/@deepseek-ai/dsh"
do
  if [ -d "$candidate/node_modules/@deepseek-ai/dsh-tools" ]; then INSTALLED="$(cd "$candidate" && pwd)"; break; fi
done

if [ -z "$INSTALLED" ] && { [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; }; then
  echo "build: 既找不到源码 checkout（\$DSH_CHECKOUT/packages），也找不到已安装的 @deepseek-ai/dsh" >&2
  exit 1
fi

# ═══ 2. 定位 tsc ═══
TSC=""
if [ -n "$CHECKOUT" ] && [ -x "$CHECKOUT/node_modules/.bin/tsc" ]; then
  TSC="$CHECKOUT/node_modules/.bin/tsc"
elif [ -x "$ROOT/node_modules/.bin/tsc" ]; then
  # 仓库自身装了 typescript（devDependency）——比借用外部环境可复现。
  TSC="$ROOT/node_modules/.bin/tsc"
elif command -v tsc >/dev/null 2>&1; then
  TSC="$(command -v tsc)"
fi
if [ -z "$TSC" ]; then
  echo "build: 找不到 tsc（\$DSH_CHECKOUT/node_modules/.bin/tsc 或 PATH 上的 tsc）" >&2
  exit 1
fi

link_pkg() { # link_pkg <node_modules 下的名字> <真实目录>
  local name="$1" target="$2"
  if [ ! -e "$target" ]; then
    echo "build: 依赖目标缺失: $target" >&2
    return 1
  fi
  node -e "
    const fs = require('fs'), path = require('path');
    const link = path.resolve(process.argv[1]), target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$name" "$target"
}

echo "=== 链接构建依赖 ==="
mkdir -p node_modules/@deepseek-ai

if [ -n "$INSTALLED" ]; then
  echo "    布局: 已安装 npm 包 ($INSTALLED)"
  NM="$INSTALLED/node_modules"
  # 源码里写的是 'cordis' / 'schemastery' / 'cosmokit'，安装名带 @deepseek-ai/ scope——
  # 按**目录**建 junction，Node 路径解析不看 package.json 的 name。
  link_pkg cordis "$NM/@deepseek-ai/cordis"
  link_pkg cosmokit "$NM/@deepseek-ai/cosmokit"
  link_pkg schemastery "$NM/@deepseek-ai/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$NM/@deepseek-ai/dsh-tools"
  link_pkg @deepseek-ai/dsh-llm "$NM/@deepseek-ai/dsh-llm"
  link_pkg @deepseek-ai/dsh-system-prompt "$NM/@deepseek-ai/dsh-system-prompt"
  link_pkg @types/node "$NM/@types/node"
  if [ -d "$NM/@standard-schema/spec" ]; then
    link_pkg @standard-schema/spec "$NM/@standard-schema/spec"
  fi
else
  echo "    布局: 源码 checkout ($CHECKOUT)"
  link_pkg cordis "$CHECKOUT/vendor/cordis"
  link_pkg cosmokit "$CHECKOUT/vendor/cosmokit"
  link_pkg schemastery "$CHECKOUT/vendor/schemastery"
  link_pkg @deepseek-ai/dsh-tools "$CHECKOUT/packages/core/tools"
  link_pkg @deepseek-ai/dsh-llm "$CHECKOUT/packages/llm/llm"
  link_pkg @deepseek-ai/dsh-system-prompt "$CHECKOUT/packages/core/system-prompt"
  link_pkg @types/node "$CHECKOUT/node_modules/@types/node"
  STD_SCHEMA=$(find "$CHECKOUT/node_modules/.pnpm" -maxdepth 1 -type d -iname '@standard-schema+spec@*' 2>/dev/null | head -1)
  if [ -n "$STD_SCHEMA" ]; then
    node -e "
      const fs = require('fs'), path = require('path');
      fs.rmSync('node_modules/@standard-schema', { recursive: true, force: true });
      fs.mkdirSync('node_modules/@standard-schema', { recursive: true });
      fs.symlinkSync(path.resolve(process.argv[1]), path.resolve('node_modules/@standard-schema/spec'), process.platform === 'win32' ? 'junction' : 'dir');
    " "$STD_SCHEMA/node_modules/@standard-schema/spec"
  fi
fi

echo "=== 编译 src → lib（$TSC） ==="
"$TSC" -p tsconfig.json
echo "=== 构建完成 ==="
