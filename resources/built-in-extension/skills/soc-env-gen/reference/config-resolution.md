# 配置解析顺序

skill 与 wrapper 脚本对所有可配置项统一遵循同一解析顺序,避免散落处理:

```
env.json 字段  >  同名环境变量  >  PATH 中的可执行名  >  报错
```

## 字段级解析

| 字段 | 默认来源 | 必填? |
|---|---|---|
| `sysbase_gen_py` | `$SYSBASE_GEN_PY` → `sysbase_gen.py` (PATH) | 否(PATH 默认即可) |
| `python_bin` | `python3` (PATH) | 否 |
| `verdi_bin` | `$VERDI_BIN` → `$VERDI_HOME/bin/verdi` → `verdi` (PATH) | 否 |
| `verdi_home` | `$VERDI_HOME` | 否 |
| `get_mod_io_pl` | `$VERDI_HOME/share/VIA/Apps/DesignComprehension/GetModIO/getModIO_batch.pl` → `getModIO_batch.pl` (PATH) | 否 |
| `proj_rtl` | `$PROJ_RTL` | 是(DE 目录,内网非标准) |
| `default_output_dir` | `./` | 否 |

注:`sysbase_gen_py` 默认走 PATH 解析,不依赖任何 env var;若内网部署以别名/绝对路径形式存在,可在 env.json 或 `$SYSBASE_GEN_PY` 覆盖。

## env.json 写法的两种姿势

**姿势 1: 显式覆盖**(只写需要覆盖的字段,其余不出现或为 null)
```json
{
  "proj_rtl": "/custom/rtl",
  "sysbase_gen_py": "/custom/path/sysbase_gen"
}
```

**姿势 2: 全字段**(从 [assets/env.json.template](assets/env.json.template) 复制,占位默认就是 PATH/env var 引用,无需改)
```json
{
  "sysbase_gen_py": "sysbase_gen.py",
  "python_bin": "python3",
  "verdi_bin": "verdi",
  "verdi_home": "$VERDI_HOME",
  "proj_rtl": "$PROJ_RTL",
  "default_output_dir": "./"
}
```

姿势 2 的好处:所有字段在文件中可见,方便审计;占位即默认值,实际运行仍由 wrapper / skill 解析。

## wrapper 实现参考

`assets/run_extract_mod_io.sh` 已按此顺序实现 get_mod_io_pl / verdi_bin 解析。其他字段(sysbase_gen_py / proj_rtl)由 SKILL.md Before You Start 在执行前按相同规则解析。

## 必填项的失败处理

若 `proj_rtl` 无法解析,skill 在 Before You Start 立刻退出,提示:

```
[FAIL] proj_rtl 无法解析
来源 1: env.json.proj_rtl
来源 2: $PROJ_RTL 环境变量
请二选一设置后重试
```

`sysbase_gen_py` 解析失败时同理,但额外提示 PATH:

```
[FAIL] sysbase_gen_py 无法解析
来源 1: env.json.sysbase_gen_py
来源 2: $SYSBASE_GEN_PY 环境变量
来源 3: PATH 中的 sysbase_gen.py
请确认脚本已加入 PATH,或显式设置以上来源之一
```

## 常见误用

- 在 env.json 写 `"python_bin": "python3"` —— 与 PATH 默认无异,no-op,删掉即可
- 在 env.json 写 `"verdi_bin": "verdi"` —— 同上
- 在 env.json 写 `"verdi_home": "/opt/verdi"` 同时不设 `$VERDI_HOME` —— OK,但建议直接 export,这样其他工具也能用
- 跨环境迁移(开发机 / 内网 / CI)时直接复制 env.json —— 会带旧路径,建议每环境 export 而非复制
