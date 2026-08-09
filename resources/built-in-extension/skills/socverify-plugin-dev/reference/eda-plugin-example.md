# EDA 日志摘要插件验收

示例插件故意选择一个窄而真实的 EDA 任务：读取项目内回归日志，提取 compile、simulation、tests、passed、failed 和 elapsed 字段，返回稳定 JSON。它不启动仿真、不修改 RTL，也不依赖具体 EDA 厂商命令，因此可以在没有 VCS/Verdi 的机器上验证插件宿主。

## 输入约定

项目相对日志示例：

```text
[EDA] compile: pass
[EDA] simulation: pass
[EDA] tests: 12
[EDA] passed: 11
[EDA] failed: 1
[EDA] elapsed_s: 42.5
```

## 输出断言

```json
{
  "status": "pass",
  "tests": 12,
  "passed": 11,
  "failed": 1,
  "elapsedSeconds": 42.5
}
```

`status` 在 compile 或 simulation 明确为 fail 时为 `fail`，否则在有日志且测试失败数为 0 时为 `pass`，缺少关键字段时为 `incomplete`。缺失日志由 `context.readFile` 抛出并由 UI 显示。

## 验收矩阵

| 场景 | 预期 |
| --- | --- |
| 完整 pass 日志 | 得到完整 JSON 摘要 |
| compile/simulation fail | `status: fail`，计数仍可见 |
| 缺少字段 | `status: incomplete`，不伪造数值 |
| 日志文件不存在 | 命令 rejected，其他插件和应用继续运行 |
| 修改入口后 reload | 新逻辑立即生效 |

把该示例当作开发模板：真实插件可以替换解析器，但应保留“项目相对输入、结构化输出、明确错误、可重复 reload”的接口形状。
