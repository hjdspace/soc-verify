---
name: officecli-xlsx
description: "使用 officecli 创建 SoC 验证相关的 XLSX 电子表格。Invoke when user requests 生成覆盖率报告、回归汇总、用例矩阵等 Excel 文档。"
---

# SoC 验证 XLSX 电子表格生成

通过 `create_xlsx` Host Tool 调用 officecli CLI，从二维数组数据生成 XLSX 电子表格。

## 适用场景

- **覆盖率报告**：各模块覆盖率汇总、按 metric 分类的覆盖率明细
- **回归汇总**：每日/每周回归运行结果、通过率统计、失败用例清单
- **用例矩阵**：子系统 × 用例类型的二维矩阵、用例优先级分布
- **里程碑跟踪**：验证进度跟踪表、里程碑达成情况
- **资源分配表**：工程师分工、服务器资源分配

## 工具调用格式

```
create_xlsx({
  sheets: Array<{
    name: string,        // 工作表名称
    data: unknown[][]    // 二维数组（行 × 列），每个元素为单元格值
  }>,
  outputPath?: string    // 输出路径（可选，默认 <project>/docs/）
})
```

### 参数说明

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `sheets` | array | 是 | 工作表数组。每个工作表包含 `name`（名称）和 `data`（二维数组） |
| `outputPath` | string | 否 | 输出路径。完整文件路径（`.xlsx` 结尾）或目录路径 |

### 数据结构

```typescript
// sheets 结构示例
[
  {
    name: "覆盖率汇总",           // 工作表名称（第一个 sheet 会重命名默认 Sheet1）
    data: [
      ["模块", "行覆盖率", "分支覆盖率"],  // 第一行通常作为表头
      ["top/cpu_core", "95.2%", "88.1%"],
      ["top/gpu", "78.3%", "65.0%"],
    ]
  },
  {
    name: "回归结果",
    data: [
      ["用例名", "状态", "耗时(s)"],
      ["cpu_alu_basic", "pass", "12"],
      ["cpu_reg_write", "fail", "45"],
    ]
  }
]
```

## 使用示例

### 示例 1：生成覆盖率报告

```
create_xlsx({
  sheets: [{
    name: '覆盖率汇总',
    data: [
      ['模块', '行覆盖率', '分支覆盖率', 'toggle覆盖率', '状态'],
      ['top', '92.3%', '87.1%', '84.0%', '未达标'],
      ['top/cpu_core', '95.2%', '88.1%', '90.0%', '行达标'],
      ['top/cpu_core/u_alu', '70.0%', '75.0%', '80.0%', '未达标'],
      ['top/cpu_core/u_reg', '85.0%', '60.0%', '82.0%', '未达标'],
      ['top/memory_ctrl', '92.0%', '88.0%', '75.0%', '未达标'],
    ]
  }],
  outputPath: 'docs/coverage-report-20260803.xlsx'
})
```

### 示例 2：生成回归测试汇总（多 sheet）

```
create_xlsx({
  sheets: [
    {
      name: '每日汇总',
      data: [
        ['日期', '总用例数', '通过', '失败', '通过率'],
        ['2026-08-01', '500', '495', '5', '99.0%'],
        ['2026-08-02', '500', '498', '2', '99.6%'],
        ['2026-08-03', '500', '500', '0', '100%'],
      ]
    },
    {
      name: '失败用例明细',
      data: [
        ['用例名', '子系统', '失败原因', '首次失败日期'],
        ['cpu_reg_write', 'cpu', '超时', '2026-08-01'],
        ['gpu_render_basic', 'gpu', '断言失败', '2026-08-01'],
      ]
    }
  ],
  outputPath: 'docs/regression-summary-20260803.xlsx'
})
```

### 示例 3：生成用例矩阵

```
create_xlsx({
  sheets: [{
    name: '用例矩阵',
    data: [
      ['子系统', '基本功能', '异常处理', '性能', '覆盖率', '总计'],
      ['cpu_core', '15', '8', '3', '12', '38'],
      ['memory_ctrl', '10', '5', '2', '8', '25'],
      ['gpu', '20', '10', '5', '15', '50'],
      ['总计', '45', '23', '10', '35', '113'],
    ]
  }],
  outputPath: 'docs/case-matrix.xlsx'
})
```

## 输出路径规则

1. **未指定 `outputPath`**：输出到 `<project>/docs/document-<timestamp>.xlsx`
2. **`outputPath` 为目录**：输出到 `<outputPath>/document-<timestamp>.xlsx`
3. **`outputPath` 为 `.xlsx` 文件路径**：输出到指定文件路径

## 注意事项

- **第一个 sheet** 会重命名默认的 `Sheet1`，后续 sheet 会新增
- 单元格值会被转为字符串存储，不支持公式、日期等特殊类型
- 列号从 A 开始（A、B、C...），行号从 1 开始
- **重要**：officecli 创建的 xlsx 可能包含特有样式/图表，若后续使用 exceljs 等库修改，图表可能丢失。建议在同一工具内完成所有编辑。
- 生成的 xlsx 可通过 `read_document` 工具回读验证内容（返回纯文本提取）
