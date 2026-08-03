---
name: officecli-pdf
description: "使用 officecli 创建 SoC 验证相关的 PDF 文档。Invoke when user requests 生成回归报告、TO 检查清单、签核文档等需要固定格式的 PDF 交付物。"
---

# SoC 验证 PDF 文档生成

通过 `create_pdf` Host Tool 调用 officecli CLI，从 Markdown 内容生成 PDF 文档。

## 适用场景

- **回归测试报告**：每日/每周回归运行结果的正式交付物
- **TO 检查清单**：Tape-Out 前的验证完成度确认清单（需签核的正式文档）
- **签核文档**：里程碑签核、阶段验收的正式记录
- **覆盖率报告**：覆盖率达成情况的正式报告（用于项目归档）
- **验证总结报告**：项目结束时的验证工作总结（用于经验沉淀）

## 工具调用格式

```
create_pdf({
  content: string,      // Markdown 内容（必填）
  outputPath?: string   // 输出路径（可选，默认 <project>/docs/）
})
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | 是 | Markdown 文本。支持 `#`/`##`/`###` 标题、`-`/`*` 列表、纯文本段落 |
| `outputPath` | string | 否 | 输出路径。完整文件路径（`.pdf` 结尾）或目录路径 |

### 生成流程

`create_pdf` 内部分两步执行：

1. **Markdown → DOCX**：将 Markdown 内容转换为 DOCX 文档（与 `create_docx` 相同的解析逻辑）
2. **DOCX → PDF**：通过 officecli 的 `view <docx> pdf -o <pdf>` 命令导出为 PDF
3. **清理中间产物**：自动删除中间生成的 DOCX 文件（best-effort）

### Markdown 支持的格式

| Markdown 语法 | PDF 映射 |
|---------------|----------|
| `# 标题` | Heading 1 |
| `## 标题` | Heading 2 |
| `### 标题` | Heading 3 |
| `- 项目` 或 `* 项目` | 项目符号列表 |
| 纯文本 | Normal 段落 |

## 使用示例

### 示例 1：生成回归测试报告

```
create_pdf({
  content: `# 回归测试报告

## 报告日期
2026-08-03

## 执行环境
- EDA 工具: VCS 2023.12
- 服务器: build-server-01 (32 核)
- 操作系统: CentOS 7.9

## 回归结果汇总
- 总用例数: 500
- 通过: 495
- 失败: 5
- 通过率: 99.0%
- 总执行时间: 4 小时 23 分钟

## 失败用例明细
- cpu_reg_write: 超时（预期 30s，实际 60s）
- gpu_render_basic: 断言失败（assertion_error @ line 142）
- memory_ctrl_burst: 数据不匹配（expected 0xFF, got 0x00）
- uart_tx_rx: 协议错误（parity mismatch）
- spi_loopback: 超时（无响应）

## 失败用例分析
- cpu_reg_write: 怀疑是时钟分频逻辑修改导致，已提交 Issue #1234
- gpu_render_basic: 怀疑是渲染管线回归，正在分析
- 其他 3 个用例: 初步判断为环境问题，正在复现

## 结论
本次回归通过率 99.0%，5 个失败用例中 1 个已定位为设计缺陷，4 个正在分析。建议保持当前版本，待失败用例修复后重新回归。`,
  outputPath: 'docs/regression-report-20260803.pdf'
})
```

### 示例 2：生成 TO 检查清单

```
create_pdf({
  content: `# CPU 子系统 TO 检查清单

## 项目信息
- 项目名称: XXX SoC
- 子系统: CPU Core
- TO 日期: 2026-09-15
- 验证负责人: 张三
- 设计负责人: 李四

## 验证完成度检查
- 用例总数: 38
- 通过: 38
- 失败: 0
- 通过率: 100%
- 关键缺陷: 0
- 次要缺陷: 2（已分析，不影响 TO）

## 覆盖率达成检查
- 行覆盖率: 96.2%（目标 95%）✓ 达标
- 分支覆盖率: 91.5%（目标 90%）✓ 达标
- toggle 覆盖率: 86.3%（目标 85%）✓ 达标
- 功能覆盖率: 96.0%（目标 95%）✓ 达标

## 回归稳定性检查
- 连续 7 天回归零失败 ✓
- 回归用例数: 38
- 平均回归时间: 45 分钟

## 签核记录
- 验证团队: 同意 TO（张三，2026-09-15）
- 设计团队: 同意 TO（李四，2026-09-15）
- 项目经理: 同意 TO（王五，2026-09-15）

## 结论
CPU 子系统验证完成度达标，所有检查项通过，同意 TO。`,
  outputPath: 'docs/cpu-to-checklist-20260915.pdf'
})
```

### 示例 3：生成项目验证总结报告

```
create_pdf({
  content: `# XXX SoC 验证总结报告

## 1. 项目概述
- 项目周期: 2026-06-01 至 2026-09-15（共 3.5 个月）
- 验证团队: 5 人
- 子系统数: 4（CPU、GPU、Memory、IO）

## 2. 验证工作量统计
- 用例总数: 156
- 验证代码行数: 12,500
- 仿真次数: 3,200
- 发现缺陷数: 47（关键 3，主要 12，次要 32）

## 3. 覆盖率达成情况
- 顶层行覆盖率: 94.5%
- 顶层分支覆盖率: 89.2%
- 各子系统均达标

## 4. 关键里程碑
- M1 (06-15): 验证环境搭建完成
- M2 (07-10): 基本功能验证通过
- M3 (08-20): 覆盖率收敛达标
- M4 (09-10): 回归测试稳定
- TO  (09-15): 签核通过

## 5. 经验与教训
- 提前启动覆盖率收敛，避免后期被动
- 建立每日回归机制，及早发现回归
- 加强设计与验证的沟通，减少理解偏差

## 6. 后续工作
- 持续监控流片后测试结果
- 沉淀验证 IP 到资产库
- 完善自动化回归框架`,
  outputPath: 'docs/project-verify-summary.pdf'
})
```

## 输出路径规则

1. **未指定 `outputPath`**：输出到 `<project>/docs/document-<timestamp>.pdf`
2. **`outputPath` 为目录**：输出到 `<outputPath>/document-<timestamp>.pdf`
3. **`outputPath` 为 `.pdf` 文件路径**：输出到指定文件路径

## 注意事项

- PDF 生成依赖 officecli 的 PDF 导出功能，需要 officecli 二进制可用
- 中间产物 DOCX 会在 PDF 生成后自动删除（best-effort，失败不影响 PDF 输出）
- Markdown 解析为基本段落结构，不支持表格、图片、代码块等复杂元素
- PDF 排版继承自 DOCX 的默认样式，如需自定义排版建议先生成 DOCX 再用 officecli 精修后导出
- 生成的 PDF 可通过 `read_document` 工具回读验证内容（返回纯文本提取）
- PDF 适合作为正式交付物（签核、归档），日常迭代建议用 DOCX（可编辑）
