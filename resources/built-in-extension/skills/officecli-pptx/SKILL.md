---
name: officecli-pptx
description: "使用 officecli 创建 SoC 验证相关的 PPTX 演示文稿。Invoke when user requests 生成验证计划评审、回归签核、TO 检查等 PPT 文档。"
---

# SoC 验证 PPTX 演示文稿生成

通过 `create_pptx` Host Tool 调用 officecli CLI，从 slides 数组生成 PPTX 演示文稿。

## 适用场景

- **验证计划评审**：子系统验证策略、里程碑、资源需求汇报
- **回归签核 Deck**：回归测试结果、稳定性趋势、风险点汇报
- **TO 检查汇报**：Tape-Out 前验证完成度、覆盖率达成情况、签核状态
- **覆盖率收敛汇报**：覆盖率趋势、低覆盖模块分析、改进计划
- **项目周报/月报**：验证进度、阻塞问题、下周计划

## 工具调用格式

```
create_pptx({
  slides: Array<{
    title: string,      // 幻灯片标题
    content: string     // 幻灯片内容（纯文本）
  }>,
  outputPath?: string   // 输出路径（可选，默认 <project>/docs/）
})
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `slides` | array | 是 | 幻灯片数组。每张幻灯片包含 `title`（标题）和 `content`（内容） |
| `outputPath` | string | 否 | 输出路径。完整文件路径（`.pptx` 结尾）或目录路径 |

### 幻灯片布局

每张幻灯片采用空白布局（blank layout），包含两个文本框：

1. **标题文本框**：顶部，Georgia 字体 36pt 加粗，深蓝色（#1E2761）
2. **内容文本框**：中部，Calibri 字体 20pt，深灰色（#333333）

## 使用示例

### 示例 1：生成验证计划评审 Deck

```
create_pptx({
  slides: [
    {
      title: 'CPU 子系统验证计划评审',
      content: '评审日期: 2026-08-03\n验证负责人: 张三\n参会人员: 验证团队、设计团队、PM'
    },
    {
      title: '验证目标',
      content: '功能覆盖率 ≥ 95%\n代码覆盖率（行） ≥ 95%\n代码覆盖率（分支） ≥ 90%\n所有 P0 用例通过\n零关键缺陷'
    },
    {
      title: '里程碑计划',
      content: 'M1 (08-10): 验证环境搭建完成\nM2 (08-20): 基本功能验证通过\nM3 (09-01): 覆盖率收敛达标\nM4 (09-10): 回归测试稳定'
    },
    {
      title: '资源需求',
      content: '验证工程师: 3 人\n仿真服务器: 8 核 × 4 台\nEDA 工具: VCS + Verdi\n预计工时: 240 人天'
    },
    {
      title: '风险与对策',
      content: '风险1: 覆盖率收敛慢 → 对策: 提前启动定向测试\n风险2: 服务器资源不足 → 对策: 错峰调度\n风险3: 设计变更频繁 → 对策: 建立变更通知机制'
    }
  ],
  outputPath: 'docs/cpu-verify-review-deck.pptx'
})
```

### 示例 2：生成 TO 签核 Deck

```
create_pptx({
  slides: [
    {
      title: 'CPU 子系统 TO 签核',
      content: '日期: 2026-09-15\n签核人: 验证负责人、设计负责人、PM'
    },
    {
      title: '验证完成度',
      content: '用例总数: 38\n通过: 38\n失败: 0\n通过率: 100%\n关键缺陷: 0\n次要缺陷: 2（已分析，不影响 TO）'
    },
    {
      title: '覆盖率达成',
      content: '行覆盖率: 96.2%（目标 95%）✓\n分支覆盖率: 91.5%（目标 90%）✓\ntoggle覆盖率: 86.3%（目标 85%）✓\n功能覆盖率: 96.0%（目标 95%）✓'
    },
    {
      title: '回归稳定性',
      content: '连续 7 天回归零失败\n回归用例数: 38\n平均回归时间: 45 分钟\n最后一次回归: 2026-09-14 22:00'
    },
    {
      title: '签核结论',
      content: '验证团队确认: CPU 子系统验证完成度达标\n建议: 同意 TO\n签核日期: 2026-09-15'
    }
  ],
  outputPath: 'docs/cpu-to-signoff-deck.pptx'
})
```

### 示例 3：生成覆盖率收敛汇报

```
create_pptx({
  slides: [
    {
      title: '覆盖率收敛周报',
      content: '汇报周期: 2026-08-01 至 2026-08-07\n汇报人: 李四'
    },
    {
      title: '本周覆盖率进展',
      content: '行覆盖率: 88% → 92%（+4%）\n分支覆盖率: 82% → 87%（+5%）\ntoggle覆盖率: 78% → 84%（+6%）\n功能覆盖率: 90% → 93%（+3%）'
    },
    {
      title: '低覆盖模块 TOP 3',
      content: '1. top/cpu_core/u_alu: 行覆盖 70%，deficit 25\n2. top/cpu_core/u_reg: 分支覆盖 60%，deficit 30\n3. top/memory_ctrl: toggle 覆盖 75%，deficit 10'
    },
    {
      title: '下周计划',
      content: '补充 ALU 边界用例（预计提升行覆盖 15%）\n补充寄存器异常分支用例（预计提升分支覆盖 20%）\n补充 memory_ctrl toggle 用例（预计提升 toggle 10%）'
    }
  ],
  outputPath: 'docs/coverage-weekly-deck.pptx'
})
```

## 输出路径规则

1. **未指定 `outputPath`**：输出到 `<project>/docs/document-<timestamp>.pptx`
2. **`outputPath` 为目录**：输出到 `<outputPath>/document-<timestamp>.pptx`
3. **`outputPath` 为 `.pptx` 文件路径**：输出到指定文件路径

## 注意事项

- 每张幻灯片采用统一的标题+内容布局，不支持自定义排版
- 内容文本框支持 `\n` 换行，但不支持富文本格式
- 幻灯片背景为白色（#FFFFFF），标题为深蓝色，内容为深灰色
- 如需更复杂的排版（图片、图表、动画），建议生成后用 officecli 的 `add`/`set` 命令精修
- 生成的 pptx 可通过 `read_document` 工具回读验证内容（返回纯文本提取）
