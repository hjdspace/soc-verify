# ADR 0022 — 知识库双转换引擎（anydoc / markitdown）

- 状态：已接受
- 日期：2026-08-16
- 关联：[ADR 0021](./0021-anydoc-document-knowledge-base.md)

## 背景

ADR 0021 将 anydoc（`@firecrawl/anydoc`，Rust NAPI 模块）作为知识库唯一的文档转换引擎。
使用中暴露两类诉求：

1. **引擎可换**：anydoc 对部分格式（扫描 PDF、损坏文档）的解析能力有限，用户希望
   可切换第二引擎（如微软开源的 [markitdown](https://github.com/microsoft/markitdown)），
   互为补充。
2. **硬约束：离线跟随打包**。引擎必须随应用分发，无网络也能用（桌面单机场景）。

markitdown 官方实现是 Python 包；npm 生态的社区移植（markitdown-js 等）依赖
`exiftool-vendored` / `fluent-ffmpeg` / `node-tesseract-ocr` / Azure SDK 等重型或
云端依赖，不满足离线约束，且均为 0.0.x 单人维护版本。

## 决策

1. **引入引擎抽象缝**（`src/main/kb/engines/types.ts`）：引擎只负责
   「字节 → Markdown 文本 + 按引用顺序的图片字节」，产物落盘（`docs/assets/<文档名>/`）
   与图片占位替换由 converter.ts 统一编排，两引擎共享同一布局。
2. **markitdown 引擎为仓库内置纯 TS 实现**（`markitdown-engine.ts`），转换行为对齐
   markitdown，全部复用仓库既有纯 JS 依赖：
   - docx / pptx：`jszip` 解析 OOXML（标题/列表/粗斜体/表格/内嵌图片）
   - xlsx / xls / csv：`xlsx`（SheetJS）→ Markdown 表格
   - pdf：`pdfjs-dist` legacy 构建（Node 兼容）文本层提取；图片型 PDF 报 unsupported
   - html / txt / json / xml：内置转换
   - 不支持 .doc/.ppt/.odt/.rtf/.epub（anydoc 支持，错误信息提示切换引擎）
3. **pdfjs-dist 外置打包**：加入 electron.vite.config.ts 主进程 `external`，运行时从
   node_modules 动态导入 legacy 构建（`pdfjs-dist/legacy/build/pdf.mjs`），与
   node-pty / better-sqlite3 同模式。
4. **引擎选择持久化在应用级设置** `<userData>/socverify-data/kb-settings.json`
   （`kb-settings.ts`）：`convertEngine` 默认 `anydoc`（既有行为不变），
   同时承载 `llm`（AI 分类模型显式配置，见下）。设置页新增「知识库」Tab。
5. **错误码沿用 anydoc 的 `ConvertErrorCode` 联合**（unsupported/malformed/encrypted/
   resourceLimit/missingPart/io），下游 UI 与测试分支不变。

## AI 分类模型显式配置（同 PR 顺带）

原 `getLlmConfig()`（kb-router.ts）为纯自动推导。现优先级调整为：

```
KB 设置显式配置（设置页知识库 Tab） > 凭证 model 字段 > Agent 会话持久化模型
> API 第一个可用模型 > provider 默认
```

未显式配置时自动推导链与既有行为完全一致；KB 设置指向的凭证被删除时静默落回自动链。

## 顺带修复：kb_search "No knowledge base mounted"

`src/main/host/tools/kb-tools.ts` 原以 `requireProject('default')` 查找项目，但项目 ID
实为 `proj_<ts>_<rand>`，查找必失败且被吞掉，导致 kb_search 永远返回未挂载。
改为使用会话 `ctx.cwd`（= 项目根目录，与 context-injector 读取 `.socverify/kb-mounts.json`
同源）。

## 后果

- 引擎切换只影响后续上传；存量文档不自动重转（重试/重新上传可重转）。
- `autoScanDocuments` 的扫描扩展名跟随当前引擎支持列表。
- 新增引擎只需实现 `ConvertEngine` 并在 `engines/index.ts` 注册，设置页自动出现。
