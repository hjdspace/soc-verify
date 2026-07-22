# Coverage Data Model — Hierarchical Tree with Coverage Triplets

当前 `CoverageData` 是扁平结构：只有 overall/line/toggle/functional/assertion 百分比 + bySubsys 扁平数组。但真实 IMC 报告有层级模块树和 covered/total 计数对。我们选择扩展为**层级树模型，每个节点上每个 metric 有 `{ percentage, covered, total }` 三元组**。

## 关键决策

1. **层级树结构**：CoverageData 包含一棵模块树，节点间有 parent/children 关系，反映设计层次（`tb_top → chip_top → dut → u_block_wrap → u_analog_mipi`）。不再使用扁平 bySubsys 数组。

2. **Coverage Triplet**：每个节点上每个 metric 的值是 `{ percentage: number | null, covered: number | null, total: number | null }`。null 表示该 metric 不适用于此模块（如纯组合逻辑模块没有 fsm coverage）。不再只有百分比。

3. **8 种 Metric**：line、branch、toggle、condition、fsm_state、fsm_transition、functional、assertion。与 coverage-closure 技能的 7 种对齐，额外增加 assertion（SVA coverage）。当前模型的 4 种（line/toggle/functional/assertion）粒度不够。

4. **Coverage Target 内置**：平台内置行业默认目标（line 95%、branch 90% 等），用户可在项目设置中覆盖。Target 与 Triplet 中的 percentage 比较来识别 Coverage Gap。

5. **数据粒度边界——模块级 + 文件/行号级，不需要 bin/实例级**：Coverage Tree 的节点粒度是**模块级**（每个 CoverageNode 代表一个设计模块，如 `u_analog_mipi`），`uncovered` 字段的粒度是**文件/行号级**（`{ module, file?, line?, signal?, description }`）。不建模 bin/实例级结构化数据（如"某个 covergroup 的某个 bin 在哪些实例下未覆盖"）。原因：
   - 模块级 + 文件/行号级已满足 Coverage Closure 的核心需求——AI 识别 gap、定位到文件/行号、生成定向测试。bin/实例级下钻是 EDA 工具原生 GUI（如 IMC）的职责，平台不重复造轮子。
   - bin/实例级数据量大（一个 covergroup 可能有数百个 bin × 多个实例），纳入 CoverageData 会膨胀，且超出 AI context window 的摘要优先策略（ADR 0009）。
   - 这个边界决定了**不引入 UCDB**（Accellera/IEEE 1800 统一覆盖率数据库）——UCDB 的优势是 bin/实例级结构化数据，但平台不需要该粒度。ADR 0006 的"文本报告统一层"在模块级 + 文件/行号级粒度上已足够。若未来某项目需要 bin/实例级，可在 `CoverageParserPlugin.parse()` 内自行扩展，平台数据模型不强加。
   - `uncovered` 字段中 `signal?` 可选字段保留了信号级定位能力（toggle/condition gap 常需信号名），但不展开为完整信号结构。

## 被拒绝的方案

- **扁平 + 增加计数**（方案 B）：保持 bySubsys 扁平数组但增加 covered/total。不建模层级关系，用户无法看到模块间的父子层次，也无法按层级折叠/展开。AI 也无法理解"u_analog_mipi 是 u_block_wrap 的子模块"这种结构信息。

- **保持现有扁平**（方案 C）：只有百分比，丢弃层级树和计数信息。AI 无法做 gap 分析（不知道 covered/total，无法判断是"少量代码未覆盖"还是"大量代码未覆盖"），UI 也无法展示层级关系。

## 数据模型草案

```typescript
type CoverageMetric = 'line' | 'branch' | 'toggle' | 'condition' 
  | 'fsm_state' | 'fsm_transition' | 'functional' | 'assertion';

type CoverageTriplet = {
  percentage: number | null;  // covered/total × 100, null if N/A
  covered: number | null;     // covered count
  total: number | null;       // total count
};

type CoverageNode = {
  name: string;               // module name (e.g., "u_analog_mipi")
  path: string;               // full hierarchical path (e.g., "tb_top.chip_top.dut.u_analog_mipi")
  depth: number;               // tree depth (0 = root)
  metrics: Record<CoverageMetric, CoverageTriplet>;
  children: CoverageNode[];
};

type CoverageData = {
  sessionId: string;           // merge session ID (replaces runId)
  source: {                    // provenance
    covMergeDir: string;        // user-specified cov_merge path
    edaTool: 'imc' | 'vcs-urg' | 'vcover' | 'unknown';
    reportGeneratedAt: number; // timestamp
  };
  root: CoverageNode;           // tree root
  targets: Partial<Record<CoverageMetric, number>>; // configured targets
  // detail report data (from report -detail -all)
  uncovered?: Record<CoverageMetric, Array<{
    module: string;
    file?: string;
    line?: number;
    signal?: string;
    description: string;
  }>>;
  // metrics report data (from report_metrics)
  metrics?: Record<string, number>; // density, complexity, etc.
};
```
