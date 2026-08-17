# xcov 方法论借鉴——自研覆盖率收敛增强，不引入 xcov 依赖

参考开源项目 xverif/xcov（面向 AI/MCP 的 VCS/Verdi coverage database 查询工具）增强本平台的 AI 辅助覆盖率收敛能力。决策：**借鉴其方法论自研，不将 xcov 作为运行时依赖**。

## 关键决策

1. **不引入 xcov 二进制依赖**：xcov 需要 Python 3.11 runtime、`VCS_HOME`（固定 `$VCS_HOME/bin/urg`）、exclusion 操作还需 `VERDI_HOME` + pynpi + Synopsys license。作为桌面应用的外部依赖，安装、版本、license 环境的排障成本转嫁给用户，且 Synopsys 私有组件（libNPI 等）不可再分发。平台自身已有 EDA Tool Configuration + CoverageParserPlugin 管道，吸收方法论比集成工具链更符合自包含定位。

2. **吸收的 xcov 方法论**（落地到自有管道）：
   - **固定 URG summary 命令**：`urg -full64 -xml_verbose -format text -show summary` 生成类型化 `session.xml` + summary 文本文件，确定性解析优先于启发式文本解析（见 ADR 0024）。
   - **URG SCORE 语义**：父 scope 的 metric 分数已包含 subtree，解析时不可重复累加；多 metric 汇总百分比取算术平均，不将不同 metric 的计数相加。
   - **批量 gap 导出**：每次 export 触发一次 URG，尽量一次提交多个 scope，避免逐 scope 反复跑 urg。
   - **coverage 收敛两条腿**：补定向测试 + exclusion（豁免）管理，exclusion 必须带 reason 且人工审批（见 ADR 0026）。
   - **EDA 执行 backend 分离**：URG 执行支持 direct / LSF 两种 backend，通过 `bsub -K` 提交 farm 作业（见 ADR 0025）。

3. **不采纳的 xcov 设计**：exclusion 的原生 EL 双向同步（pynpi 上下文、CSV source of truth、strict 模式）——依赖 NPI 遍历与 license，平台用自有审批数据模型 + urg `-elfile` 单向应用替代；run manifest provenance 校验（VDB 内容 hash 门禁）——当前单用户桌面场景收益不足。

## 被拒绝的方案

- **直接集成 xcov CLI**（stdio-loop JSON 协议）：功能最全（scope 查询、exclusion 管理、内容寻址 cache），但引入 Python runtime + VCS_HOME/VERDI_HOME + license 环境依赖链，内网离线环境分发与排障成本高。
- **双模式**（自研管道 + 可选 xcov 后端）：两条解析路径长期并存，测试矩阵翻倍，主→渲染契约维护成本高。

## 关联

- [ADR 0024](0024-urg-session-xml-first-parsing.md) — session.xml 优先解析管道
- [ADR 0025](0025-closure-recovery-and-module-target.md) — 平台驱动 Coverage Recovery + 模块级 Closure Target
- [ADR 0026](0026-coverage-exclusion-chain.md) — Exclusion 完整链路
