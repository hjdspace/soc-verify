# urg-xml 测试 fixture

工单 02（ADR 0024：urg session.xml 优先解析）的测试样本。

## ⚠️ 构造样本声明（重要）

当前无 VCS 环境，本目录下所有 fixture 均为**按 xcov 文档描述构造的样本**，
非真实 urg 产物。schema 依据 `urg -full64 -xml_verbose -format text -show summary`
会生成「带类型层级分数的 session.xml」的描述，按以下结构建模：

```xml
<session>
  <report type="summary">
    <scope name="<实例名>">          <!-- 层级 scope，可嵌套（≥3 层） -->
      <coverage type="line|branch|toggle|condition|fsm|assertion|functional"
                score="<百分比>" covered="<已覆盖>" total="<总数>"/>
      <scope name="...">...</scope>  <!-- 子 scope -->
    </scope>
  </report>
</session>
```

- `coverage` 元素缺失（或 score/covered/total 均缺）→ 该 metric 不适用，三元组为 null
- 负值 sentinel（如 -1）与 covered > total → 解析错误（fail-closed）

**拿到真实 VCS 环境后，必须用真实 urg 产物回归本目录 fixture 与解析器**
（`plugins/builtin-coverage-parser/index.js` 的 `parseUrgSessionXml`），
确认 schema、metric type 取值与属性名是否与真实 session.xml 一致。

## 文件清单

| 文件 | 用途 |
|------|------|
| `session.xml` | 主 fixture：3 层 scope 树（tb_top → u_core → u_alu/u_decoder）+ 兄弟 u_mem；多 metric type；tb_top/u_mem 的 functional 不适用（null）；父 scope 分数 ≠ 子分数之和（URG SCORE 语义：父分数已含 subtree，直接取 XML 值，禁止累加） |
| `text/dashboard.txt` + `text/hierarchy.txt` | 仅 text 报告的旧目录（降级路径回归） |
| `priority/dashboard.txt` + `priority/hierarchy.txt` | 内容**故意错误**，与 session.xml 同目录时验证 XML 优先（未走 text 路径） |
| `priority/line.dat` | XML 优先场景下 .dat 未覆盖项解析回归 |
| `invalid/covered-gt-total.xml` | 违规数据：covered > total → 解析错误 |
| `invalid/negative-sentinel.xml` | 违规数据：负值 sentinel（-1）→ 解析错误 |

## SCORE 语义固化点（对应测试断言）

- tb_top line = 900/1000（90.00%），子 scope 合计 = 190+640=830/1000——
  父分数直接取 XML，任何按 descendants 累加的实现都会得到 830 而非 900
- 多 metric 聚合的 coverage_pct 应为各 metric 百分比的算术平均；
  平台数据模型按 metric 独立建模，解析器不产出聚合计数
