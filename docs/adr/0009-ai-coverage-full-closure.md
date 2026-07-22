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

6. **AI 上下文工具扩展**：完整闭环要求 AI 自动生成定向测试，仅靠覆盖率数据不足以生成有效测试——AI 还需要 RTL 源码和现有测试结构作为上下文。新增两个 Host Tools：
   - `get_module_source(module)` — 返回指定模块的 RTL 源码（含文件路径、行号范围）。AI 用于理解 gap 所在模块的实现逻辑。
   - `get_test_template(case)` — 返回现有测试用例的结构（testbench 框架、virtual sequence 模式、env 配置）。AI 照着现有模式生成新测试，保证风格一致。
   不提供完整项目索引（易超 context window），不提供协议文档（用户在触发时按需指定）。这两个工具是"结构化上下文"——比让 AI 用 `read_file` 盲目读取更可控，比提供完整项目索引更轻量。

7. **Closure Workspace 隔离机制**：AI 生成的测试代码不直接写正式项目目录，而是写到 Closure Workspace（`.socverify/coverage/closure/<closureId>/`）。`run_simulation` Host Tool 扩展支持 `workDir` 参数，从临时目录执行仿真。5 轮迭代中所有改动留在临时目录，不污染正式 testbench/。闭环结束后通过 Test Promotion（决策 10）决定哪些测试提升到正式目录。UI 实时显示 Closure Workspace 中的改动、当前 gap、轮次、delta，用户可随时中止。

8. **多 Gap 并行调度（Gap Scheduler）**：一次 Coverage Closure 可能识别出多个 Gap（如 10 个模块的 line coverage 不达标）。采用**完全并行**策略——所有 Gap 同时开始处理，受 SessionManager 并发上限（10）限制。每个 Gap 拥有独立的 AI Agent 会话和独立的仿真流程（独立仿真 + 独立 merge + 独立 report），精确计算单个 Gap 的 Delta。并行最大化收敛速度（10 Gap 并行 ≈ 串行时间的 1/10）。不采用"按模块分组并行"（分组逻辑复杂且 CoverageManager 需理解模块层级）；不采用"合并仿真 + 按模块归因 delta"（归因不准，AI 无法判断哪个 Gap 的测试有效）。

9. **Delta Validation 分阶段路线图**：完整闭环的最大风险是假覆盖——AI 生成的测试碰巧覆盖代码行（line coverage 上升）但没验证功能。Delta Validation 分阶段引入：
   - **Phase 1**：不检测。Delta 检查看数字上升即认为有效，假覆盖风险靠闭环结束后 Diff Review 兜底。最简单，先跑通闭环。
   - **Phase 2**：多指标联动检查。修复 line gap 要求 line + branch 同步上升；修复 fsm gap 要求 fsm_state + fsm_transition 同步上升。单一指标上升但联动指标未动标记为可疑 delta。
   - **Phase 3**：assertion 同步上升检查。要求 AI 生成的测试包含 assertion/checker，且 assertion coverage 同步上升才算有效 delta。最严格，防止"碰巧行覆盖"。
   分阶段引入避免一次性增加复杂度，前期靠人工审阅兜底，后期逐步自动化提升可信度。

10. **Diff Review 整合与 Test Promotion**：闭环内与闭环后分离处理 AI 测试代码改动：
    - **闭环内**：AI 改动留在 Closure Workspace，UI 实时显示进度（PRD 用户故事 49-50）。不阻塞自动迭代——用户可观察、可中止，但不需要每轮审阅。每轮生成后审阅会破坏 5 轮自动迭代的定位。
    - **闭环后**：闭环结束（达到目标 / 5 轮上限 / 用户中止）后，Closure Workspace 中的所有测试改动进入 Diff Review 队列。用户通过 Test Promotion 决定哪些测试"提升"到正式项目目录——接受的从临时目录复制到正式 testbench/，拒绝的丢弃。复用现有 Diff Review 域（CONTEXT.md 已定义 Hunk/Review Queue/Delayed Batch Apply）。
    不采用"闭环内直接写正式目录 + 结束后 git diff 审阅"（依赖项目用 git 且增加 git 操作复杂度）；不采用"闭环内每轮审阅"（破坏自动迭代）。

## 被拒绝的方案

- **只读分析**（方案 A）：AI 只读取覆盖率、识别 gap、给出文字建议，不生成代码。不利用 AI 的代码生成能力，无法实现 Coverage Closure 的自动化价值。

- **分析 + 测试建议**（方案 B）：AI 识别 gap 并生成测试代码建议，但用户需要手动复制执行。比方案 A 进一步，但用户仍需手动操作，无法实现迭代自动化。作为初始阶段可行，但不是最终目标。

- **一次性全量数据**（方案 B 数据策略）：`get_coverage` 返回整个 Coverage Tree。数百个模块 × 8 种 metric × 3 个值 = 大量数据，可能超出 context window，且 AI 不需要一次性看所有数据。

- **原始文本透传**（方案 C 数据策略）：`get_coverage` 返回 IMC 生成的原始文本报告。AI 需要自己解析文本，不如结构化数据高效，且不同 EDA 工具的文本格式不同，AI 需要适配多种格式。

- **UCDB 统一覆盖率数据库**：引入 Accellera/IEEE 1800 UCDB 作为跨 EDA 厂商的统一抽象层。但 UCDB 没有消除"各家 export 命令不同"的问题（Cadence/Synopsys/Mentor 的 UCDB 导出命令各不相同），只是在文本报告之上多一层抽象。且需要额外解析库依赖，要求 EDA 工具支持 UCDB export，增加部署门槛。ADR 0006 的"文本报告统一层"已实现跨厂商兼容目标（每个厂商一个命令模板 + 一个解析插件），UCDB 收益不明显。若未来某项目需要 bin/实例级结构化数据，可在 `CoverageParserPlugin.parse()` 内自行处理，平台不强加。

- **闭环内每轮 Diff Review**：AI 每轮生成测试后暂停，Diff Review 通过才 run_simulation。最安全，但 5 轮迭代需要 5 次人工审阅，破坏"完整闭环自动迭代"的定位，效率提升打折。闭环后一次性 Diff Review（Test Promotion）在安全性和效率间取得平衡。

- **合并仿真 + 按模块归因 delta**：所有 Gap 的测试合并跑一次仿真，按模块归因 delta。资源消耗小，但归因不准——一个 Gap 的测试可能提升多个模块，或多个 Gap 的测试同时提升同一模块。AI 无法精确判断哪个 Gap 的测试有效，可能撤销有效测试或保留无效测试。每个 Gap 独立仿真（决策 8）虽资源消耗大，但 delta 精确，并行跑缓解时间问题。
