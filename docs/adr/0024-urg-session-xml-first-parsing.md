# urg 报告管道修正——session.xml 优先解析 + text 降级

VCS urg 的 summary 命令与解析管道修正：summary 报告改用 `-xml_verbose -show summary` 生成类型化 `session.xml`，解析器优先读 XML，启发式文本解析保留为降级路径。

## 关键决策

1. **summaryCommand 修正**：`urg -full64 -dir {covMergeDir} -xml_verbose -format text -show summary -report {reportDir}`。产物为类型化 `session.xml`（带类型层级分数的 XML）+ summary 文本文件（dashboard.txt / hierarchy.txt 等），不生成完整 HTML / modinfo.txt / grpinfo.txt。来自 xcov 已验证的固定命令形态。

2. **原全量 text 报告命令移作 detailCommand**：`urg -full64 -dir {covMergeDir} -format text -report {reportDir}/detail`，其 `*.dat` 产物继续供 uncovered/gap 项导出。summary 与 detail 分离后各自缓存、互不影响。

3. **解析器优先级**：session.xml（确定性，元素/属性结构稳定）→ dashboard.txt + hierarchy.txt（启发式，列名随 urg 版本变化，保留为降级路径）→ 全部缺失时报错。旧报告目录（无 session.xml）自动走降级路径，向后兼容。

4. **URG SCORE 语义固化到解析器**：父 scope 分数已含 subtree，禁止累加 descendants；多 metric 聚合百分比取算术平均；`covered > total`、负值 sentinel 视为解析错误 fail-closed，不适用值用 null。

5. **covMergeDir 默认值修正**：`'urgReport'`（urg 典型输出目录名，语义错误）改为 `'cov_merge'`。该目录必须包含 simv.vdb / merged.vdb 等 VDB 数据。

6. **验收约束**：当前无 VCS 环境，session.xml fixture 依据 xcov 文档描述的 schema 构造样本；端到端验收 mock EDA 命令，真实环境验证延后（fixture 需在拿到真实环境后回归）。

## 被拒绝的方案

- **仅修 covMergeDir 默认值**：改动最小，但 dashboard.txt/hierarchy.txt 启发式解析的脆弱性（列名随 urg 版本变化、防御式正则)仍在，层级树数据质量不可控。
- **完全复刻 xcov 命令集**（gap 导出也走按 scope 的受限 text report）：解析最稳健，但 gap 导出变成按需交互式查询，与现有"一次导入全量解析 + 缓存"的架构冲突，改动面过大。
