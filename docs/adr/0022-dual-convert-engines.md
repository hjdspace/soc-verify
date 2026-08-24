# ADR 0022 — 知识库转换引擎（anydoc）

- 状态：已废弃（markitdown 引擎已移除）
- 日期：2026-08-16（原定），2026-08-25（markitdown 移除）
- 关联：[ADR 0021](./0021-anydoc-document-knowledge-base.md)

## 背景

ADR 0021 将 anydoc（`@firecrawl/anydoc`，Rust NAPI 模块）作为知识库唯一的文档转换引擎。
ADR 0022 曾引入 markitdown 纯 TS 兼容引擎作为第二引擎，互为补充。

经实际测试，markitdown 引擎在转换质量上不如 anydoc，且引入了额外的打包体积
（pdfjs-dist 外置打包）。决定移除 markitdown 引擎，回归 anydoc 单引擎。

## 决策（当前）

1. **保留引擎抽象缝**（`src/main/kb/engines/types.ts`）：引擎只负责
   「字节 → Markdown 文本 + 按引用顺序的图片字节」，产物落盘
   （`docs/assets/<文档名>/`）与图片占位替换由 converter.ts 统一编排。
2. **仅保留 anydoc 引擎**（`anydoc-engine.ts`），markitdown 引擎及其相关代码已删除。
3. **引擎选择设置保留**（`kb-settings.ts`）：`convertEngine` 默认且仅支持 `anydoc`，
   `ConvertEngineId` 类型简化为 `'anydoc'`。设置页「知识库」Tab 仅保留 AI 分类模型配置。
4. **pdfjs-dist 从主进程 external 移除**：主进程不再动态导入 pdfjs-dist。
   pdfjs-dist 移至 devDependencies（仅供渲染端 PdfPreview 使用）。
5. **错误码沿用 anydoc 的 `ConvertErrorCode` 联合**（unsupported/malformed/encrypted/
   resourceLimit/missingPart/io），下游 UI 与测试分支不变。

## AI 分类模型显式配置（保留）

```
KB 设置显式配置（设置页知识库 Tab） > 凭证 model 字段 > Agent 会话持久化模型
> API 第一个可用模型 > provider 默认
```

未显式配置时自动推导链与既有行为完全一致；KB 设置指向的凭证被删除时静默落回自动链。

## 移除清单

- `src/main/kb/engines/markitdown-engine.ts` — 已删除
- `src/main/types/pdfjs-dist.d.ts` — 已删除（主进程不再动态导入 pdfjs-dist legacy build）
- `electron.vite.config.ts` — 从 `external` 移除 `pdfjs-dist`
- `package.json` — `pdfjs-dist` 从 `dependencies` 移至 `devDependencies`
- `src/shared/kb-types.ts` — `ConvertEngineId` 简化为 `'anydoc'`
- `src/main/kb/engines/index.ts` — 移除 markitdown 注册
- `src/main/kb/kb-settings.ts` — `ENGINE_IDS` 仅含 `anydoc`
- `src/renderer/src/components/settings/KbSettingsTab.tsx` — 移除引擎切换 UI
- `tests/kb-markitdown-engine.test.ts` — 已删除
- `tests/kb-converter-engines.test.ts` — 移除 markitdown 测试用例
- 各测试文件中的 `markitdown` 引用已替换为 `anydoc`

## 后果

- 引擎选择已固定为 anydoc；设置页不再展示引擎切换卡片。
- `autoScanDocuments` 的扫描扩展名跟随 anydoc 支持列表。
- 新增引擎只需实现 `ConvertEngine` 并在 `engines/index.ts` 注册，设置页可重新启用引擎切换。
