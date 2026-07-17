# RTL 路径与例化名约定

skill 在 Step 1 按本文件规则自动推导 `-rtl` / `-n` / `-i`。用户显式提供的参数优先,推导仅在缺失时生效。

## 关键配置

- `proj_rtl`: 从 `env.json` 读(默认 `$PROJ_RTL`),DE 提供的 RTL 总目录

## subsys 推导

给定 subsys `<name>`(如 `apcpu_sys`、`gpu_sys`):

| 参数 | 推导规则 | 示例(`name=apcpu_sys`) |
|---|---|---|
| `-n` | `<name>` | `apcpu_sys` |
| `-i` | `u_sys_<strip_sys_suffix>` | `u_sys_apcpu` |

`<strip_sys_suffix>` 规则:
- 末尾有 `_sys` 则去掉
- 末尾无 `_sys` 保持原样

### `-rtl` 推导:AI 读候选文件判定顶层 wrapper

**原则**: `-rtl` 指向 subsys 的**顶层文件**(power wrapper),不是目录。命名约定是 `*_pwr_wrap.v`,但**前缀不可信** — 同一项目可能并存 `<name>_pwr_wrap.v` / `<stripped>_top_pwr_wrap.v` / `<stripped>_pwr_wrap.v` 等多种命名。AI 必须读候选文件的内容,基于**层级关系**判定哪个是顶层。

**Step A: 收集候选**

`<rtl>/top/*_pwr_wrap.v` glob 结果:

- 0 命中 → 内联提示"`<rtl>/top/` 下无 `*_pwr_wrap.v`;若顶层 wrapper 用了别的后缀,请在输入中显式给 `-rtl` 覆盖"

**Step B: 解析 module 名**

每个候选 `c` 提取 module 名称:

- 命令: `grep -hE '^[[:space:]]*module[[:space:]]+[A-Za-z_][A-Za-z0-9_]*' <c> | head -1`
- 记为 `mod_<c>`。找不到 module 行的候选记入"异常集",Step E 报告。

**Step C: 找顶层候选(un-instantiated)**

对每个候选 `c`,在其他候选文件里 grep 是否出现对 `mod_<c>` 的例化(整词匹配):

- 命令: `grep -lwE 'mod_<c>' <other_candidates...> | wc -l` → 记为 `instantiated_by_count_<c>`
- `instantiated_by_count_<c> == 0` → 候选 `c` 是**顶层候选**(没有任何其他 `*_pwr_wrap.v` 例化它)

**原理**: pwr_wrap 文件之间形成层级,顶层是**没有父例化**的那个 — 与命名无关,跟 hierarchy 一致。

**Step D: 顶层候选数判定**

- 0 个 → 内联提示"所有 `*_pwr_wrap.v` 都被另一个包了,无法判定顶层;请在输入中显式给 `-rtl`"
- 1 个 → 用它
- ≥2 个 → 在顶层候选里优先选 module 名**包含** `<name>`(完整或 strip `_sys` 后,大小写不敏感)的那一个;都不含或并列 → AskUserQuestion 列出所有顶层候选的 module 名 + 文件路径,用户选

**Step E: 报告异常**

异常集(Step B 找不到 module 行的候选)用 AskUserQuestion 单独报告,问用户是忽略还是另作处理。

**Step F: 落 `-rtl` 绝对路径**

把选中的文件**绝对路径**写入 `-rtl`。如果用户输入了相对路径,按 `proj_rtl` 拼绝对。

## top 推导

| 参数 | 推导规则 | 示例 |
|---|---|---|
| `-n` | `top` | `top` |
| `-i` | 需用户确认(无统一规则) | — |

top 的 `-i` 没有 subsys 那样的强规则,skill 推导后必须经用户确认。

### `-rtl` 推导

候选目录 `${proj_rtl}/top/design/rtl/top`,走 subsys 推导的 Step A~F(同算法,`<name>` 在 top 场景用字面量 `top` 参与 Step D 匹配)。

## 覆盖规则

- 用户在输入中显式给出 `-rtl` / `-n` / `-i`,按用户值为准
- 推导值必须经用户 y / n 确认才进入 Step 2
- `env.json.proj_rtl` 缺失时,提示用户设置或手动给 `-rtl` 路径

## 路径校验

Step 1 完成后立即 `ls -l <derived_rtl_file>`,**必须是 regular file**;目录命中或缺失都判失败。

## 例外

- `<name>` 含空格 / 中文 / 连字符时,推导值用引号包裹
- `proj_rtl` 含 `~` 时,展开为 `$HOME`
- 用户输入的 `-n` 与仓名不一致时,Step 1 不阻断(Step 2 收参数时由用户决定是否覆盖)
- 项目顶层 wrapper 不用 `_pwr_wrap.v` 后缀时,用户在输入中显式给 `-rtl` 覆盖
