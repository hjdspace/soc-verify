# 错误码与修复

sysbase_gen.py 失败时,skill 按此表匹配错误模式并给出修复建议。

## 错误码表

| 错误码 | 触发关键词(stderr) | 修复建议 |
|---|---|---|
| `RtlNotFound` | "No such file" / "rtl not found" | 检查 `-rtl` 路径 |
| `RalStructureBad` | "for_de" / "for_dv" / "for_sw" | 检查 `-ral` 子目录结构 |
| `ClkFilesMissing` | "clk_max" / "set_clk_freq" | 补全或换 DE clk 目录 |
| `ExcelNotFilled` | "Excel" / ".xlsx" / "empty" | 请用户填好对应列后重发 |
| `ModIoMissing` | "mod_io" / "module io" | 跑 run_extract_mod_io.sh 抓 mod_io,见 Step 4 |
| `FilelistMissing` | (Step 4 内部预检) | 用户未提供 `-f <filelist>`,请显式给 filelist 路径 |
| `OutputDirNotEmpty` | "not empty" / "permission" | 换空目录或清空 `-o` |
| `Unknown` | (以上都不匹配) | 原样输出 stderr 末尾 50 行 |

## 匹配逻辑

```python
import re

PATTERNS = [
    (r"No such file|rtl not found", "RtlNotFound"),
    (r"for_de|for_dv|for_sw", "RalStructureBad"),
    (r"clk_max|set_clk_freq", "ClkFilesMissing"),
    (r"Excel|\.xlsx|empty", "ExcelNotFilled"),
    (r"mod_io|module io", "ModIoMissing"),
    (r"not empty|permission", "OutputDirNotEmpty"),
]

def classify(stderr: str) -> str:
    for pattern, code in PATTERNS:
        if re.search(pattern, stderr, re.IGNORECASE):
            return code
    return "Unknown"
```

## 输出格式

skill 失败时向用户输出:

```
[FAIL] sysbase_gen.py 退出码 <N>
[ERROR_CODE] <RalStructureBad>
[原因] stderr 中包含 "for_de" 关键词,ral 目录结构不完整
[修复] 请检查 <ral_path> 目录,确保每个子目录含:
       - for_de/
       - for_dv/
       - for_sw/
[stderr 末尾]
...
```

## 维护

新增错误模式时,在 PATTERNS 中追加 (regex, code) 二元组,并同步更新上方表格。code 命名遵循 PascalCase,语义清晰。
