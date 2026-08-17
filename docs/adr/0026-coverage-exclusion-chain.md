# Coverage Exclusion 完整链路——建议 → 审批 → EL 应用

Coverage Closure 的第二条腿：对 AI 判定为 dead_code / unreachable 的 gap，通过 exclusion（豁免）而非硬补测试收敛。对齐 ADR 0009 决策 5 的人工介入原则与 xcov 的 exclusion 方法论，但不引入其 pynpi 依赖。

## 关键决策

1. **AI 只建议，不执行**：AI 在 Triage 升级（连续低 delta 转人工）时，对判定为 dead_code 根因的 gap 输出 exclusion 建议——语义 selector（module + metric + file/line 或 bin 名）+ 必填 reason。建议存入 closure 的 triage 数据，状态 pending。

2. **人工审批 UI**：闭环详情页的 exclusion 审批面板列出全部 pending 建议（selector、reason、AI 置信度），用户逐条 approve / reject。审批通过才进入应用流程。不做批量自动通过。

3. **平台单向生成 EL 并应用**：审批通过的条目由平台生成 urg `-elfile` 格式的 exclusion 文件（`.socverify/coverage/exclusions/<sessionId>.el`），下次 Coverage Preprocessing / Coverage Recovery 的 urg 命令附加 `-elfile <path>` 应用。单向（审批数据 → EL），不做 EL 反向导入、不做 pynpi 原生 exclusion 状态读写（依赖 NPI + license，见 ADR 0023 不采纳项）。

4. **豁免后的达标语义**：应用 exclusion 后重跑报告，被排除项从 covered/total 计数中移除，Coverage Target 判定基于豁免后的数字。closure 迭代历史记录豁免前后两套数字，保证可追溯。

## 被拒绝的方案

- **仅建议记录，不应用**（分期到下期）：交付快，但 dead_code gap 的闭环仍断——审批通过后无处落地，用户仍需手动写 EL 文件。
- **复刻 xcov 的 CSV source of truth + 四 EL 双向同步**：功能完整但依赖 pynpi 原生 exclusion 状态读取，license 与环境成本高；单用户桌面场景下审批数据模型 + 单向 EL 生成已覆盖核心价值。
