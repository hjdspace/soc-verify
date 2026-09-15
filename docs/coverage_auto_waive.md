# 0. 背景与目标
## 0.1 这个工具解决什么问题
在 SoC 验证环境中，Cadence xrun / imc (Verisium Manager) 负责仿真与覆盖率收集。coverage 数据库里存在大量“永远不可能翻转（toggle）”的信号，例如：
- RTL 里写了 `assign X = 1'b0;` （X 被固定为常数，toggle 覆盖率必然漏掉）
- 某个子模块的输入端口被 tie 成常数（如 `clk_sel` 接 `1'b0`）
- 某个子模块的输出端口悬空（floating）未连接
这类信号天然 0% toggle 覆盖，却会污染覆盖率报告。本工具静态分析 RTL 源码，识别出这些「结构性不可覆盖」的信号，生成一份 Cadence 兼容的 `.vRefine` XML 排除文件（waiver）。这个文件可被 `imc load -refinement` 加载，把这些信号从覆盖率统计中排除。
## 0.2 三个核心概念
| 术语 | 含义 | 输出中的体现 |
| --- | --- | --- |
| assign 固定值 | `assign Sig = 常量;` | 对 `<实例>.<Sig>` 生成排除 rule |
| input tie | 子例化端口的输入被接成常量 | 对 `<父实例>.<子例化名>.<端口>` 生成排除 rule |
| output 悬空 | 子例化端口的输出未连接（floating） | 对 `<父实例>.<子例化名>.<端口>` 生成排除 rule |

# 1. 输入数据格式
## imc detail模式（`cov`目录） - 已实现
引擎内部执行如下命令：
    imc -load <cov_dir> -nocopyright -execmd "report -detail -all -out detail.txt"
( `cov_dir` 是被 `cov.filter` 过滤过的 coverage 数据库；`-nocopyright` 抑制版权横幅；`-out` 指定输出文件。)

然后解析 `detail.txt`，提取关键数据：
 1. Instance name: <层级信息>
 2. Type name: <模块名>
 3. File name: <文件路径>
 4. Number of covered blocks: 3 of 3 - block覆盖率百分比，即3/3 = 100%
 5. Number of covered branches: 2 of 2 - branch覆盖率百分比，即2/2 = 100%
 6. Number of covered statements: 2 of 2 - statement覆盖率百分比，即2/2 = 100%;

# 2. RTL静态分析引擎
输入解析 `detail.txt`提取好的关键数据，找到assign固定值、module例化括号内填写常量值或者浮空的信号。//行注释、/* ... */块注释需要跳过

## 2.1 常量与正则（python版本作为参考）
```python
# assign 固定值: 匹配 `assign <sig_or_sig[bit]> = <const>;`
RE_ASSIGN_CONST = re.compile(
    r'assign\s+(\w+(?:\s*\[[^\]]+\])?)\s*=\s*(\''
    r'"d+\s*'r'[s*S]?\s*[bB]\s*[01xXzZ_]+|"'  # N'b<二进制,含0/1/x/z/?/_>
    r'"d+\s*'r'[s*S]?\s*[hH]\s*[0-9a-fA-FxXzZ_]+|"'
    r'"d+\s*'r'[s*S]?\s*[dD]\s*d+|'
    r'"d+\s*'r'[s*S]?\s*[oO]\s*[0-7xXzZ_]+|'
    r'"1\s*'r'[bB]\s*[01xX]|'
    r'"'\s*[bB]\s*[01xX]|'
    r'"'\b[01]\b'
    r')\s*;',
    re.IGNORECASE)

# 例化端口连接 : .PORT_NAME(EXPR)
RE_PORT_CONNECT = re.compile(r'\.\s*(\w+)\s*\(\s*(\s*([^)]*)\s*)\s*\)')

# 例化点头部 `<mod> <inst>`
RE_INSTANCE_HEAD = re.compile(r'\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*\(')

# 例化点第一个 token 不能是这些关键字（否则误中 always/task/assign 等）
INSTANCE_HEAD_KEYWORD_BLACKLIST = {
    'module', 'endmodule', 'always', 'assign', 'wire', 'reg',
    'input', 'output', 'inout', 'begin', 'if', 'else', 'case',
    'for', 'generate', 'initial', 'task', 'function', 'integer',
    'parameter', 'localparam', 'casez', 'casex', 'endcase',
    'endtask', 'endfunction', 'endgenerate', 'always_ff',
    'always_comb', 'always_latch'
}
# 被例化 module 定义内的端口方向声明: `input/output/inout [width] name`
RE_PORT_DIR_DECL = re.compile(
    r'\s*(input|output|inout)\b\s+(?:\[[^\]]+\])?\s+(\w+)', re.MULTILINE)

# 例化行内尾随方向注释: `.port(conn), // I u_xxx` / `// O` / `// IO`
RE_INLINE_DIR_COMMENT = re.compile(r'//\s*(I|O|IO)\b')

# 判断一个字符串是否 Verilog 常数（整数匹配）
RE_CONST_VAL = re.compile(
    r'^\s*('
    r"\d+\s*'?\s*[sS]?\s*[bB]\s*[01XxZz?_]+|" 
    r"\d+\s*'?\s*[sS]?\s*[hH]\s*[0-9a-fA-FxXzZ?_]+|" 
    r"\d+\s*'?\s*[sS]?\s*[dD]\s*\d+|" 
    r"\d+\s*'?\s*[sS]?\s*[oO]\s*[0-7xXzZ?_]+|" 
    r"1'\s*[bB]\s*[01xX]|" 
    r"'[bB]\s*[01xX]|"
    r"'[01]"
    r")\s*$")
```

# 3. `.vRefine` XML生成
## 3.1 单条toggle rule
``` python
_build_toggle_rule(hier_path, signal, file_id, line_no):
    hier_path = trim(hier_path); signal = trim(signal)
    若 signal 空 → 返回 ""（无效）

    # top_scope 越界过滤
    若 top_scope 非空 且 hier_path 非空 且 不以 top_scope 开头:
        若 hier_path 不含 "." → hier_path = top_scope + "." + hier_path     # module 名补前缀
        否则 → 返回 ""                                                      # 越界跳过
    full_dotted = hier_path+"."+signal(若 hier_path 空则仅 signal)
    若 top_scope 非空 且 full_dotted 不以 top_scope 开头 → 返回 ""
    entity_name = full_dotted 里所有 "." 替换成 "/"       # ★ 分隔符是 / , 不是 . ! !

    属性 (顺序固定) :
        ccType="inst" domain="icc" entityName=<entity_name> entityType="toggle"
        excTime=<unix epoch 秒> name="exclude_covered"
        reviewer="1" user="0" vscope="default"
        若 file_id ≠ 0            → file="<file_id>"
        若 line_no > 0            → line="<line_no>"
    所有属性值做 XML 转义 (& < > " ')
    返回 '        <rule <attrs>></rule>' (4 空格缩进, 自闭标签)
```

## 3.2 完整的XML骨架
```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<refinement-file-root>
    <information comment-version="2" creation-time="<strftime('%a %d %b %Y %H:%M:%S CST')>" creator="<getpass 用户名>" csCheck="true" save-ref-method="seq" tool-version="Cadence Verisium Manager24.09">
        <ucm-files/>
        <ccf-files/>
        </ccf-files>
    </information>
    <rules>
        <rule ...></rule> ← 每个生成的 toggle rule (顺序: 先 assign, 再 tie, 再 floating)
    </rules>
    <cache-map>
        <cache-entry key="0" value="<creator 用户名>"></cache-entry>
        <cache-entry key="1" value="unknown"></cache-entry>
        <cache-entry key="<file_id>" value="<绝对路径>"></cache-entry> ← 遍历 file_map 全量
    </cache-map>
</refinement-file-root>
```

字段细节：
- creator = 当前系统用户名 (getpass.getuser())。
- excTime = Unix epoch 秒整数（所有 rule 用同一个时间戳）。
- creation-time = strftime 格式 %a %d %b %Y %H:%M:%S CST （如 Mon 08 Sep 2026 19:30:00 CST）。
- cache-map :
    - key 0 → 用户名, key 1 → 字符串 "unknown" （占位约定）。
    - 再遍历 hierarchy["file_map"] 全量映射。
    - key/value 都做 XML 转义。
- 生成的每条 rule 若因 top_scope 越界返回空串 "" (_build_toggle_rule 返回空), 丢弃；统计数不计入。
- generate() 返回有效 rule 总数（不含越界丢弃的）。

### 真实覆盖率示例
```xml
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<refinement-file-root>
    <information comment-version="2" creation-time="Thu 23 Jul 2026 08:51:46 CST" creator="xxx" csCheck="true" save-ref-method="seq" tool-version="Cadence Verisium Manager24.09" rules-signature-c="c49241c2460297eaade33ad0566c">
        <ucm-files>
            <ucm-file domain="icc" modelCheckSum="431838799" path="/proj/ProjectName/socl/username/coverage_merge/top_merge_cov/regr_cov_work_20260720_094744/cov_merge/icc_19bd564f_5b8f88e8.ucm"></ucm-file>
        </ucm-files>
        <ccf-files>
        </ccf-files>
    </information>
    <rules>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/AVDD_USB20_3P3" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/USB20_SCAN_IN" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/USB20_SCAN_OUT" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/AVSS_USB20" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/DVDD_USB20" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/DVSS_USB20" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule ccType="inst" domain="icc" entityName="tb_top/chip_top/dut/u_block_wrap_1/u_analog_usb20_0/VSS_USB20" entityType="toggle" excTime="1784601305" name="exclude_covered" reviewer="1" user="0" vscope="default"></rule>
        <rule cb-checksum="1800490649" ccType="inst" ccfFlagsMask="70369012636098-42" dcExpr="(utmi_mux_2x2_sel == 1'b0) ? drvbus_ctrl1 : drvbus_ctrl0" dcExprIndex="0" domain="icc" entityName="tb_top/chip_top/dut/u_digital_top/u_utmi_mux_2x2/22" entityType="top-expr" excTime="1784767717" file="2" im-checksum="1864144006" line="309" name="exclude_covered" reviewer="1" text="(utmi_mux_2x2_sel == 1'b0) ? drvbus_ctrl1 : drvbus_ctrl0" ung="0" user="0" vscope="default"></rule>
        <rule cb-checksum="1823027659" ccType="inst" ccfFlagsMask="70369012636098-42" dcExpr="(utmi_mux_2x2_sel == 1'b0) ? chargvbus_ctrl1 : chargvbus_ctrl0" dcExprIndex="0" domain="icc" entityName="tb_top/chip_top/dut/u_digital_top/u_utmi_mux_2x2/23" entityType="top-expr" excTime="1784767717" file="2" im-checksum="1864144006" line="310" name="exclude_covered" reviewer="1" text="(utmi_mux_2x2_sel == 1'b0) ? chargvbus_ctrl1 : chargvbus_ctrl0" ung="0" user="0" vscope="default"></rule>
        <rule cb-checksum="989587495" ccType="inst" ccfFlagsMask="70369012636098-42" dcExpr="(utmi_mux_2x2_sel == 1'b0) ? bvalid_hsphy1 : bvalid_hsphy0" dcExprIndex="0" domain="icc" entityName="tb_top/chip_top/dut/u_digital_top/u_utmi_mux_2x2/50" entityType="top-expr" excTime="1784767717" file="2" im-checksum="1864144006" line="341" name="exclude_covered" reviewer="1" text="(utmi_mux_2x2_sel == 1'b0) ? bvalid_hsphy1 : bvalid_hsphy0" ung="0" user="0" vscope="default"></rule>
        <rule cb-checksum="1674630453" ccType="inst" ccfFlagsMask="70369012636098-42" dcExpr="(utmi_mux_2x2_sel == 1'b0) ? iddig_hsphy1 : iddig_hsphy0" dcExprIndex="0" domain="icc" entityName="tb_top/chip_top/dut/u_digital_top/u_utmi_mux_2x2/48" entityType="top-expr" excTime="1784767717" file="2" im-checksum="1864144006" line="339" name="exclude_covered" reviewer="1" text="(utmi_mux_2x2_sel == 1'b0) ? iddig_hsphy1 : iddig_hsphy0" ung="0" user="0" vscope="default"></rule>
        <rule cb-checksum="253205009" ccType="inst" ccfFlagsMask="70369012636098-42" dcExpr="(utmi_mux_2x2_sel == 1'b0) ? dischargvbus_ctrl1 : dischargvbus_ctrl0" dcExprIndex="0" domain="icc" entityName="tb_top/chip_top/dut/u_digital_top/u_utmi_mux_2x2/24" entityType="top-expr" excTime="1784767717" file="2" im-checksum="1864144006" line="311" name="exclude_covered" reviewer="1" text="(utmi_mux_2x2_sel == 1'b0) ? dischargvbus_ctrl1 : dischargvbus_ctrl0" ung="0" user="0" vscope="default"></rule>
    </rules>
    <cache-map>
        <cache-entry key="0" value="username"></cache-entry>
        <cache-entry key="1" value="unknown"></cache-entry>
        <cache-entry key="2" value="/proj/KunlunN02/gitview/jiadong.he2/view_top/de/top/design/rtl/glue_logic/utmi_mux_2x2.v"></cache-entry>
    </cache-map>
</refinement-file-root>

```

## 3.3 输出文件的生成顺序
 1. 把所有 const_assign 规则加入
 2. 把所有 tie 规则加入
 3. 把所有 floating 规则加入
 4. 过滤掉无效（空）rule
 5. 渲染 XML，UTF-8 写文件（末尾一个换行）

# 4. 特别关注
在解析module文件，当该module中例化其他module时，需要关注该例化module信号括号内的tie值和悬空情况下的信号拼接。
假设某个模块的层级路径是tb_top.chip_top.dut.u_digital_top.u_module_a，其内部例化了module_b：
```verilog
module module_a (
    input a,
    input b,
    output c
)
 ...

 module_b u_module_b(
    .x(a),
    .y(   1'b0 ),
    .z(  1'b1 ),
    .c(c)
 );
endmodule
```
这种情况下，抽取出来的tie值信号就是：
 - tb_top.chip_top.dut.u_digital_top.u_module_a.u_module_b.y
 - tb_top.chip_top.dut.u_digital_top.u_module_a.u_module_b.z
