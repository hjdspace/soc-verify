# Coverage Preprocessing Pipeline — Platform Generates + Plugin Parses

EDA 覆盖率数据不能直接处理，需要先通过 EDA 工具命令（如 Cadence IMC 的 `imc -load . -execcmd "report -summary -out..."`）生成文本报告。我们将这个预处理流水线拆为两步：**平台运行 EDA 命令生成文本报告，CoverageParserPlugin 只负责解析文本报告为结构化数据**。

## 关键决策

1. **两步分离**：第一步（平台）根据 EDA Tool Configuration 运行 EDA 工具命令，生成 summary/detail/metrics 三种文本报告。第二步（插件）解析文本报告为 Coverage Tree。两步通过文本报告文件解耦。

2. **平台负责 EDA 命令执行**：不同 EDA 工具（Cadence IMC / Synopsys VCS urg / Mentor Questa vcover）的命令差异不大，平台按 EDA Tool Configuration 中的命令模板执行。报告生成到 `.socverify/coverage/<session_id>/reports/` 目录。

3. **插件只解析文本**：CoverageParserPlugin 接收文本报告路径，输出 Coverage Tree。插件可针对不同报告格式实现不同解析逻辑，但不需要知道 EDA 工具如何执行。

4. **三种报告同时生成**：summary（层级树摘要）、detail（每实例/bin 详情）、metrics（密度/复杂度）。一次 EDA 命令调用可生成多种报告。

## 被拒绝的方案

- **全在插件里**（方案 A）：CoverageParserPlugin 负责运行 EDA 命令 + 解析文本。插件需要知道 EDA 工具路径、命令语法、环境变量，与"插件只做解析"的职责定位不符。且不同项目的 EDA 工具可能不同，命令执行逻辑重复。

- **用户手动生成**（方案 C）：用户自己在终端跑 `imc`/`urg` 命令生成文本报告，插件只解析。最接近 coverage-closure 技能的 standalone 模式，但用户体验差——用户需要记住命令、手动执行、指定输出路径。平台的价值正是自动化这些步骤。
