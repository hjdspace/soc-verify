# AI Coverage Analysis — Full Closure Scope with Summary-First Data Strategy

AI 辅助覆盖率分析的目标是完整 Coverage Closure：识别 Gap → 生成定向测试 → 运行仿真 → 检查 Delta → 迭代。AI Agent 通过 Host Tools 获取覆盖率数据，采用**摘要优先 + 按需下钻**的数据获取策略，避免大量覆盖率数据超出 context window。

## 关键决策

1. **完整 Coverage Closure 范围**：AI 能力覆盖三个阶段——Sub-stage A（生成 covergroup）、Sub-stage B（分析覆盖率结果、识别 gap、分类根因）、Sub-stage C（生成定向测试、运行仿真、检查 delta、迭代）。与 coverage-closure 技能对齐，但通过平台 Host Tools 获取数据而非自己运行 `parse_coverage.py`。

2. **摘要优先数据策略**：`get_coverage` Host Tool 返回顶层摘要 + 覆盖率最低的 N 个模块（而非整个 Coverage Tree）。AI 通过新的 `get_coverage_detail(module_name)` Host Tool 按需下钻到特定模块的详细覆盖率。`cov://<session_id>` URI 返回摘要树，`cov://<session_id>/<module>` 返回模块详情，`cov://<session_id>/<module>/uncovered` 返回未覆盖项。

3. **Host Tools 改造**：
   - `get_coverage` — 返回 `{ sessionId, summary: Record<Metric, CoverageTriplet>, worstModules: Array<{ name, path, metrics, deficit }>, targets }`，不返回整个树。
   - `get_coverage_detail`（新增）— 参数 `{ module: string }`，返回指定模块及其直接子模块的 Coverage Triplet。
   - `cov://` URI handler — 从空壳改为调用 CoverageManager 返回分层覆盖率数据。

4. **coverage-closure 技能适配**：coverage-closure 技能不再自己运行 `parse_coverage.py`，而是通过 Host Tools 获取结构化覆盖率数据。技能提供工作流指令（gap 识别 → 根因分类 → 测试生成 → 仿真 → delta 检查），AI Agent 调用 Host Tools 执行具体操作。

5. **人工介入点**：Dead code 确认和 Coverage Exclusion 审批需要人工介入，AI 不可自动排除。连续 2 轮 Delta < 1% 触发升级，转人工审查。

## 被拒绝的方案

- **只读分析**（方案 A）：AI 只读取覆盖率、识别 gap、给出文字建议，不生成代码。不利用 AI 的代码生成能力，无法实现 Coverage Closure 的自动化价值。

- **分析 + 测试建议**（方案 B）：AI 识别 gap 并生成测试代码建议，但用户需要手动复制执行。比方案 A 进一步，但用户仍需手动操作，无法实现迭代自动化。作为初始阶段可行，但不是最终目标。

- **一次性全量数据**（方案 B 数据策略）：`get_coverage` 返回整个 Coverage Tree。数百个模块 × 8 种 metric × 3 个值 = 大量数据，可能超出 context window，且 AI 不需要一次性看所有数据。

- **原始文本透传**（方案 C 数据策略）：`get_coverage` 返回 IMC 生成的原始文本报告。AI 需要自己解析文本，不如结构化数据高效，且不同 EDA 工具的文本格式不同，AI 需要适配多种格式。
