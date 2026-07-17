# SOC 命令模板

按层级渲染 `${sysbase_gen_py} <args...>`,脚本默认在 PATH(`sysbase_gen.py`),可通过 `env.json.sysbase_gen_py` 或 `$SYSBASE_GEN_PY` env var 覆盖。占位符由用户在 Step 2 收集。

## subsys 层级

```bash
${sysbase_gen_py} \
  -rtl  <subsys_rtl> \
  -n    <subsys_name> \
  -i    <inst_name> \
  -x    <dut_spec_xlsx> \
  -mini <mini_excel_xlsx> \
  -mod_io <mod_io_csv> \
  -ral  <de_ral_dir> \
  -clk  <de_clk_dir> \
  -o    ${output_dir}
```

可选(条件满足时追加):

- `-clk2 <de_path>,<prefix>` — 多 clk core 才加
- `-pinlist <pin_xlsx>` — 后续补
- `-dmalist <dma_xlsx>` — 后续补

## top 层级

```bash
${sysbase_gen_py} \
  -rtl <chip_rtl> \
  -n   <chip_name> \
  -i   <chip_inst> \
  -c   <top_csv> \
  -ral <de_ral_dir_1> <de_ral_dir_2> \
  -o   ${output_dir}
```

## 多 ral 目录

`-ral` 支持多个独立 reg 目录,空格分隔,每个目录下都必须含 `for_de` / `for_dv` / `for_sw`:

```
-ral /de/projA/reg_top /de/projB/reg_audio
```

也支持单份 HLD 工具生成的 systba ral model 文件(直接给文件路径)。

## 渲染规则

- `${sysbase_gen_py}` 不需 `python3` 前缀——脚本以可执行形式入 PATH(若用户的部署是 .py 文件需 python 解释,自行加回 `python3`)
- `-n` 必须与仓名一致(subsys 层)
- `-i` 必须在 top rtl 中能找到对应例化
- `-o` 目录必须为空(脚本后处理会在该目录下展开)
- 路径含空格时用引号包裹

## 调试

dry-run 思路: 先用 `--help`(若脚本支持) 验证参数解析,再正式跑。
