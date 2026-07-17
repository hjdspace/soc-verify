#!/bin/bash
# run_extract_mod_io.sh
# 包装 Synopsys Verdi getModIO_batch.pl 抓 mod_io
# 用法: run_extract_mod_io.sh <rtl_dir> -f <filelist> [-o <output_log>] [-modules "<pattern>"]
#
# 必填:
#   <rtl_dir>      RTL 根目录(供输出 log 默认位置)
#   -f <filelist>  filelist 路径(由用户提供,不自动推导)
#
# 可选:
#   -o <output_log>    输出 log,默认 <rtl_dir>/mod_io.log
#   -modules "<pat>"   目标 module 模式,空格分隔多 module,支持通配
#                      默认空 = 报所有 modules
#
# getModIO_batch.pl 解析顺序:
#   1. env.json.get_mod_io_pl (若存在且非空)
#   2. ${VERDI_HOME}/share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.pl
#   3. PATH 中的 "getModIO_batch.pl"
#
# 输出:
#   - perl 脚本产出 <output_log>
#   - Step 4 后续由 AI 读 log 提取 module/port/direction/range
#     写 <output_dir>/mod_io.csv 作为 -mod_io 入参
#
# 退码:
#   0  - log 已生成
#   非 0 - filelist 缺失 / perl 不可用 / perl 报错

set -e

if [ $# -lt 3 ]; then
    echo "Usage: $0 <rtl_dir> -f <filelist> [-o <output_log>] [-modules \"<pattern>\"]"
    exit 1
fi

INPUT_DIR="$1"; shift

FILELIST=""
OUTPUT_LOG=""
MODULES=""

while [ $# -gt 0 ]; do
    case "$1" in
        -f)       FILELIST="$2"; shift 2;;
        -o)       OUTPUT_LOG="$2"; shift 2;;
        -modules) MODULES="$2"; shift 2;;
        *) echo "[FAIL] 未知参数: $1"; exit 1;;
    esac
done

# 必填校验
if [ ! -d "$INPUT_DIR" ]; then
    echo "[FAIL] 输入目录不存在: $INPUT_DIR"
    exit 1
fi
if [ -z "$FILELIST" ] || [ ! -f "$FILELIST" ]; then
    echo "[FAIL] filelist 不存在或未指定: ${FILELIST:-<未提供>}"
    echo "请 -f <filelist> 显式提供(此参数由用户提供,skill 不自动推导)"
    exit 1
fi
[ -z "$OUTPUT_LOG" ] && OUTPUT_LOG="$INPUT_DIR/mod_io.log"

# 解析 getModIO_batch.pl
ENV_JSON="$INPUT_DIR/env.json"
JSON_PL=""
if [ -f "$ENV_JSON" ]; then
    JSON_VAL=$(grep -o '"get_mod_io_pl"[[:space:]]*:[[:space:]]*"[^"]*"' "$ENV_JSON" | sed 's/.*"\([^"]*\)"$/\1/' | head -1)
    if [ -n "$JSON_VAL" ] && [ "$JSON_VAL" != "\$GET_MOD_IO_PL" ]; then
        JSON_PL="$JSON_VAL"
    fi
fi

if [ -n "$JSON_PL" ]; then
    PL_BIN="$JSON_PL"
elif [ -n "$VERDI_HOME" ] && [ -x "$VERDI_HOME/share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.pl" ]; then
    PL_BIN="$VERDI_HOME/share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.pl"
else
    PL_BIN="getModIO_batch.pl"
fi

if ! command -v "$PL_BIN" >/dev/null 2>&1 && [ ! -x "$PL_BIN" ]; then
    echo "[FAIL] getModIO_batch.pl 不可用: $PL_BIN"
    echo "请设置 VERDI_HOME,或在 env.json 显式指定 get_mod_io_pl"
    exit 1
fi

echo "[INFO] getModIO_batch.pl: $PL_BIN"
echo "[INFO] rtl dir:    $INPUT_DIR"
echo "[INFO] filelist:   $FILELIST"
echo "[INFO] output log: $OUTPUT_LOG"
echo "[INFO] modules:    ${MODULES:-(空=全部)}"

# 调用 perl 脚本
PL_ARGS=(-f "$FILELIST" -o "$OUTPUT_LOG")
[ -n "$MODULES" ] && PL_ARGS+=(-modules "$MODULES")

"$PL_BIN" "${PL_ARGS[@]}"

# 检查输出
if [ -f "$OUTPUT_LOG" ]; then
    echo "[OK] mod_io log 已生成: $OUTPUT_LOG"
    echo "[INFO] 前 30 行预览:"
    head -30 "$OUTPUT_LOG"
    echo ""
    echo "[NEXT] AI 读 log 内容,提取 module_name,port_name,direction,range"
    echo "       写 $(dirname "$OUTPUT_LOG")/mod_io.csv 作为 -mod_io 入参"
else
    echo "[FAIL] $OUTPUT_LOG 未生成,请检查 perl 脚本日志"
    exit 1
fi
