#!/usr/bin/env bash
# ============================================================================
# SoC Verify 桌面版 Linux 启动脚本
#
# 对齐 Python 参考版 GUI（runsim_gui.sh）的启动方式：在启动应用进程之前，
# 先把 python3 装进本进程的 PATH。应用内的 log-mode 仿真子进程
# （`csh -c "runsim ..."`）会原样继承这份环境，因此即使 .cshrc 里的
# Environment Modules 初始化因状态冲突而中断（"cannot be loaded due to a
# conflict" / "list element in quotes followed by ':' instead of space"），
# runsim 内部的 `python` 仍能解析到 python3，不会回落到系统 python2 而报
# `TypeError: 'encoding' is an invalid keyword argument for this function`。
#
# 用法:
#   ./launch-soc-verify.sh [AppImage 路径] [应用参数...]
#
# 环境变量:
#   SOCVERIFY_PYTHON_MODULE   要加载的 python module 名，
#                             默认 tool/python/3.11.10（与 runsim_gui.sh 一致）
#   SOCVERIFY_APPIMAGE        AppImage 路径（等价于第一个位置参数）
# ============================================================================

set -euo pipefail

PYTHON_MODULE="${SOCVERIFY_PYTHON_MODULE:-tool/python/3.11.10}"

# ── 1. 清理遗留的 Environment Modules 运行时状态 ──────────────────────────
# 父 shell 已加载的 module 状态会让子 csh 重新 source .cshrc 时产生冲突。
# 全部清空后再重新加载，行为与 fresh login shell 一致。
unset LOADEDMODULES _LMFILES_ MODULE_VERSION MODULE_VERSION_STACK 2>/dev/null || true
unset _ModuleTable* 2>/dev/null || true

# ── 2. 加载 python3 module，把 python3 前置到 PATH ────────────────────────
# 与 runsim_gui.sh 的 `module unload tool/python/3.9.7` +
# `module load tool/python/3.11.10` 对齐。
if type module >/dev/null 2>&1; then
    # 卸载旧版本 python module（可能不存在，静默忽略失败）
    module unload tool/python/3.9.7 2>/dev/null || true
    if module load "${PYTHON_MODULE}" 2>/dev/null; then
        echo "[launch] 已加载 module: ${PYTHON_MODULE}"
    else
        echo "[launch] 警告: 加载 module ${PYTHON_MODULE} 失败，尝试使用当前 PATH 中的 python3" >&2
    fi
else
    echo "[launch] 提示: 当前 shell 无 module 命令，跳过 module 加载" >&2
fi

# 校验 python3 可用（仅提示，不阻断——仿真是远程 csh 子进程解析 python）
if command -v python3 >/dev/null 2>&1; then
    echo "[launch] python3: $(command -v python3) ($(python3 --version 2>&1))"
else
    echo "[launch] 警告: PATH 中找不到 python3，仿真可能回落到 python2" >&2
fi

# ── 3. 设置 UTF-8 locale ─────────────────────────────────────────────────
# 与 runsim_gui.sh 对齐：保证仿真日志扫描（PASS/FAIL 关键词、编译错误解析）
# 在非 UTF-8 默认 locale 的系统上不出现乱码/误判。
export LANG="${LANG:-en_US.UTF-8}"
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
export PYTHONIOENCODING=utf-8

# ── 4. 定位 AppImage ─────────────────────────────────────────────────────
APPIMAGE="${1:-${SOCVERIFY_APPIMAGE:-}}"
if [ -z "${APPIMAGE}" ]; then
    # 依次搜索：脚本所在目录 → ~/soc-verify → ~/Applications → ~/Downloads
    SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    for dir in "${SCRIPT_DIR}" "${SCRIPT_DIR}/../dist" \
               "${HOME}/soc-verify" "${HOME}/Applications" "${HOME}/Downloads"; do
        candidate="$(find "${dir}" -maxdepth 1 -name 'SoC Verify-*.AppImage' 2>/dev/null | sort -V | tail -n 1 || true)"
        if [ -n "${candidate}" ]; then
            APPIMAGE="${candidate}"
            break
        fi
    done
fi

if [ -z "${APPIMAGE}" ] || [ ! -f "${APPIMAGE}" ]; then
    echo "错误: 未找到 SoC Verify AppImage。" >&2
    echo "用法: $0 <AppImage 路径> [应用参数...]" >&2
    echo "或设置环境变量 SOCVERIFY_APPIMAGE 后直接运行。" >&2
    exit 1
fi

echo "[launch] 启动: ${APPIMAGE}"
exec "${APPIMAGE}" "${@:2}"
