# ADR 0021: anydoc 文档知识库——Markdown 转换、多库注册与 Agent 接入

## 状态

Proposed

## 背景

SoC 验证周期内存在大量非代码文档：协议手册（AMBA/MIPI/DDR）、DUT spec、验证计划、设计评审材料，多为 pdf/docx/pptx。这些文档目前无法被 AI Agent 消费——omp 引擎只能读文本文件，Agent 承接"看一下这个 word 文档"类任务时无路可走。

现有 officecli 集成（ADR 0015）只覆盖 **Markdown → Office**（生成方向），**Office → Markdown**（提取方向）完全空白。

选定 [anydoc](https://github.com/firecrawl/anydoc)（firecrawl 出品，MIT，Rust + NAPI）作为转换引擎，依据：

- 14 种格式全覆盖（doc/docx/ppt/pptx/xls/xlsx/odt/rtf/epub/csv/pdf...）， benchmarks 中唯一全覆盖且各格式质量分最高
- 纯本地、无 ML 模型、无外部服务，median < 5ms/文档，符合内网离线约束
- 标准 npm 包 `@firecrawl/anydoc`，预编译 NAPI 二进制随 npm 分发，TypeScript 类型随包
- 已知限制：无 OCR，扫描版 PDF 返回 `unsupported` 错误码

经 grilling 确认 9 项决策，与 ADR 0015（officecli 生成方向）互补，共同构成完整的文档能力。

## 决策

### 1. 集成方式：npm 依赖直接打包（不走 officecli 下载器模式）

`npm install @firecrawl/anydoc` 作为应用依赖，electron-builder 配 `asarUnpack: ["**/*.node"]` 解包原生模块。NAPI 二进制 ABI 跨 Electron 版本稳定，无需 rebuild；主进程直接函数调用（libuv 线程池，不阻塞事件循环），无子进程 spawn 开销。二进制在构建期进入安装包，最终用户完全离线可用——满足内网 Linux 约束，且比 officecli 省掉运行时三级回退链。

**与 officecli 模式不同的原因**：officecli 是独立二进制分发（非 npm 包），才需要下载脚本 + 路径回退；anydoc 是标准 npm 包，直接依赖是更简路径。

### 2. 作用域：多库注册、项目挂载

- **KB Registration** 存应用全局配置：用户可注册任意目录为知识库（空目录注册时初始化标准结构）
- **KB Mount** 存项目配置：项目选择挂载哪些库；v1 只支持挂载一个库，数据结构与工具接口按多库设计
- 多库而非项目级单库：协议手册（跨项目复用）与 DUT spec（项目专属）两类文档都需要归宿

### 3. 库结构：源文件入库，自包含

```
<kb>/
├── sources/                  # Source Document 原始副本（上传即复制）
│   └── DDR5_JESD79-5.pdf
├── docs/                     # 转换产物
│   ├── 协议手册/             # Auto Classification 产生的分类子目录
│   │   └── DDR5_JESD79-5.md
│   └── assets/
│       └── DDR5_JESD79-5/    # 每文档独立图片资产目录
│           └── image-001.png
└── index.md                  # KB Index
```

源文件入库的代价（pdf 双倍存储）换来：库可整体拷走、同事间共享、重新转换不丢源。

### 4. 转换流水线

上传（拖拽/选择）→ 复制到 `sources/` → anydoc `toDocument()` 转换 → 图片字节写 `docs/assets/<文档名>/` + markdown 内 alt 替换为相对路径 → LLM 单次调用（Auto Classification + Fast Reindex：分类 + 摘要 + 关键词）→ 移入分类目录 → 增量合并 `index.md`。

- **同名上传覆盖**并自动重转，不做版本历史、不做文件系统 watch
- **失败可见**：列表展示 anydoc 错误码（`unsupported`/`encrypted`/`malformed`...），可重试；扫描版 PDF 明确提示不支持（OCR 超范围）

### 5. 索引：单文件 + 双模式生成

- **KB Index**（`index.md`）：层级目录树 + 每文档标题/一句话摘要/关键词/相对链接，人机共读，Agent 一读即得全库地图
- **Fast Reindex**（默认）：直连 LLM API 一次调用（应用已配置的 openai-compatible 端点），基于文档骨架，秒级，上传后自动增量触发
- **Deep Reindex**（可选）：走完整 omp Agent 会话，逐文档深读重写摘要，手动触发

### 6. Agent 接入：两工具 + 上下文注入

| 通道 | 形式 | 用途 |
| --- | --- | --- |
| `doc_to_markdown` | Host Tool，参数 `path`，返回 markdown 内容，不入库 | Agent 决策"看 word/pdf 文档"任务的主路径 |
| `kb_search` | Host Tool，关键词/全文检索挂载库，返回路径+摘要 | 库大后 index 注入被截断时的定位手段 |
| 索引注入 | 会话创建时把挂载库 `index.md` 注入 Agent 上下文（复用 session-context 机制） | Agent 零工具调用即知库内有什么 |

`kb_add`（Agent 自主入库）留 v2——需要防污染审批机制，v1 入库仅限用户 UI 操作。

### 7. UI：LeftRail 入口 + Workbench destination

LeftRail 新增"知识库"入口，`workbench.open({ type: 'kb' })` 打开管理视图：左侧分类树 + 右侧文档列表（拖拽上传区、转换状态、失败重试）、库索引查看/编辑、markdown 预览（含图片）。库注册/挂载在项目设置 + 库头部切换器。

## 新增模块（规划）

```
src/main/kb/
├── registry.ts          # KB Registration（全局配置读写、结构初始化）
├── converter.ts         # anydoc 封装（toDocument + assets 落盘 + 链接替换）
├── indexer.ts           # Fast Reindex（LLM 调用）+ index.md 增量合并
├── searcher.ts          # kb_search 实现
└── types.ts
src/main/ipc/routers/kb-router.ts      # tRPC 子路由
src/main/host/tools/kb-tools.ts        # doc_to_markdown + kb_search
```

依赖仅新增 `@firecrawl/anydoc`。

## 考虑的替代方案

- **officecli 式独立二进制下载**：多一套下载器 + 每次 spawn 子进程开销；anydoc 是 npm 包，无此必要（被否）
- **项目级单库**：协议手册需要跨项目重复入库（被否）
- **只存 markdown 不存源文件**：库不自包含，源被删/换机器后无法重转（被否）
- **md + json 双索引**：双文件一致性维护成本，第一版价值不大（被否）
- **平铺 + 虚拟标签分组**：目录结构失去物理意义，文件系统层面无法按类浏览（被否）
- **丢弃图片**：SoC 文档的框图/时序图/位段图信息完全丢失，人类预览体验差（被否，改提取入库）
- **Agent 可自主入库（kb_add）**：污染风险（乱命名/乱分类），需审批机制，留 v2（暂缓）
- **OCR 补扫描版 PDF**：引入 ML 服务违背离线约束，明确不支持并在 UI 提示（拒绝）

## 后续

UI 原型见 `docs/prototypes/knowledge-base.html`，供界面决策后按垂直切片实施（参考 ADR 0014 切片策略）。
