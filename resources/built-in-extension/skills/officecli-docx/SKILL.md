---
name: officecli-docx
description: "使用 officecli 创建 SoC 验证相关的 DOCX 文档。Invoke when user requests 生成验证计划、测试规格、评审报告、TO 检查清单等 Word 文档。"
---

# SoC 验证 DOCX 文档生成

通过 `create_docx` Host Tool 调用 officecli CLI，从 Markdown 内容生成专业排版的 DOCX 文档。

## 适用场景

- **验证计划文档**：子系统/顶层验证策略、里程碑、资源分配
- **测试规格说明**：用例描述、激励生成策略、预期结果、覆盖目标
- **评审报告**：设计评审、代码评审、覆盖率评审的会议纪要与行动项
- **TO 检查清单**：Tape-Out 前的验证完成度确认、签核记录
- **回归报告**：每日/每周回归运行汇总、失败用例分析

## 工具调用格式

```
create_docx({
  content: string,      // Markdown 内容（必填）
  outputPath?: string   // 输出路径（可选，默认 <project>/docs/）
})
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `content` | string | 是 | Markdown 文本。支持 `#`/`##`/`###` 标题、`-`/`*` 列表、纯文本段落 |
| `outputPath` | string | 否 | 输出路径。完整文件路径（`.docx` 结尾）或目录路径。默认 `<project>/docs/document-<timestamp>.docx` |

### Markdown 支持的格式

| Markdown 语法 | DOCX 映射 |
|---------------|-----------|
| `# 标题` | Heading 1 |
| `## 标题` | Heading 2 |
| `### 标题` | Heading 3 |
| `- 项目` 或 `* 项目` | 项目符号列表 |
| 纯文本 | Normal 段落 |

## 使用示例

### 示例 1：生成验证计划文档

```
create_docx({
  content: `# CPU 子系统验证计划

## 1. 概述
本文档描述 CPU 子系统（top/cpu_core）的验证策略与里程碑。

## 2. 验证目标
- 功能覆盖率 ≥ 95%
- 代码覆盖率（行） ≥ 95%
- 代码覆盖率（分支） ≥ 90%
- 所有 P0 用例通过

## 3. 里程碑
- M1: 验证环境搭建完成
- M2: 基本功能验证通过
- M3: 覆盖率收敛达标
- M4: 回归测试稳定

## 4. 资源分配
- 验证工程师: 3 人
- 服务器: 8 核 × 4 台
- EDA 工具: VCS + Verdi`,
  outputPath: 'docs/cpu-verify-plan.docx'
})
```

### 示例 2：生成覆盖率评审报告

```
create_docx({
  content: `# 覆盖率评审报告

## 评审日期
2026-08-03

## 当前覆盖率状态
- 行覆盖率: 92.3%（目标 95%，差距 2.7%）
- 分支覆盖率: 87.1%（目标 90%，差距 2.9%）

## 低覆盖模块 TOP 5
- top/cpu_core/u_alu: 行覆盖 70%，deficit 25
- top/cpu_core/u_reg: 分支覆盖 60%，deficit 30
- top/memory_ctrl: toggle 覆盖 75%，deficit 10

## 行动项
- 补充 ALU 边界用例（负责人: 张三，截止: 2026-08-10）
- 补充寄存器异常分支用例（负责人: 李四，截止: 2026-08-12）`,
  outputPath: 'docs/coverage-review-20260803.docx'
})
```

## 输出路径规则

1. **未指定 `outputPath`**：输出到 `<project>/docs/document-<timestamp>.docx`
2. **`outputPath` 为目录**：输出到 `<outputPath>/document-<timestamp>.docx`
3. **`outputPath` 为 `.docx` 文件路径**：输出到指定文件路径（相对路径基于项目根目录）

## 注意事项

- 文档默认输出到 `<project>/docs/` 目录，若目录不存在会自动创建
- Markdown 解析为基本段落结构，不支持表格、图片、代码块等复杂元素
- 如需更复杂的排版，建议生成后再用 officecli 的 `add`/`set` 命令精修
- 生成的 docx 可通过 `read_document` 工具回读验证内容
