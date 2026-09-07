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

# module load 会按 modulefile 的设定修改 LD_LIBRARY_PATH（站点 modulefile
# 通常会前置 /tools/opensources/openssl/openssl-1.1.1a/lib 之类的公共库
# 目录）。这些旧版共享库会遮蔽系统库，导致 AppImage 启动时报
#   libcrypto.so.1.1: version `OPENSSL_1_1_1b' not found
#     (required by /lib64/libk5crypto.so.3)
# ——直接执行 AppImage 正常、经脚本启动就报错的原因即在此（动态链接器
# 对 LD_LIBRARY_PATH 的搜索优先于系统默认路径）。
# 本脚本只需要 module 提供的 PATH（python3），故先快照 LD_LIBRARY_PATH，
# 启动 AppImage 前恢复为登录 shell 的原始值。
LD_LIBRARY_PATH_SAVED="${LD_LIBRARY_PATH:-}"

# ── 1. 清理遗留的 Environment Modules 运行时状态 ──────────────────────────
# 父 shell 已加载的 module 状态会让子 csh 重新 source .cshrc 时产生冲突。
# 全部清空后再重新加载，行为与 fresh login shell 一致。
# 注意：modulecmd 会为主变量维护配套的 *_modshare 记账变量（记录每个路径
# 元素由哪个 shell 导出）。若只 unset 主变量而留下 modshare 变量，执行
# module load 时会报 "WARNING: LOADEDMODULES_modshare exists ... but
# LOADEDMODULES doesn't. Environment is corrupted."，因此必须成对清理。
unset LOADEDMODULES LOADEDMODULES_modshare _LMFILES_ _LMFILES__modshare \
     MODULE_VERSION MODULE_VERSION_STACK 2>/dev/null || true
unset _ModuleTable* 2>/dev/null || true

# ── 2. 加载 python3 module，把 python3 前置到 PATH ────────────────────────
# 与 runsim_gui.sh 的 `module unload tool/python/3.9.23` +
# `module load tool/python/3.11.10` 对齐。
if type module >/dev/null 2>&1; then
    # 卸载旧版本 python module（可能不存在，静默忽略失败）
    module unload tool/python/3.9.23 2>/dev/null || true
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

# ── 5. 恢复 LD_LIBRARY_PATH，避免 module 注入的旧版共享库遮蔽系统库 ──────
if [ -n "${LD_LIBRARY_PATH_SAVED}" ]; then
    export LD_LIBRARY_PATH="${LD_LIBRARY_PATH_SAVED}"
else
    unset LD_LIBRARY_PATH 2>/dev/null || true
fi

exec "${APPIMAGE}" "${@:2}"
