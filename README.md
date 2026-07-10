# SoC Verify

AI Agent 驱动的 SoC 验证一站式管理平台。SoC 验证工程师从项目 kickoff 到 TO（Tape-Out）后的所有工作都能在此完成。

## 技术栈

- Electron 43 + electron-vite 5
- React 19 + TypeScript 7
- Tailwind v4 + shadcn/ui
- Zustand 5
- electron-trpc 0.7（主↔渲染 IPC）
- oh-my-pi（omp，RPC Mode，AI 基座）

## 开发

```sh
npm install
npm run dev        # 启动 electron-vite dev（三栏空壳）
npm run lint
npm run test
npm run typecheck
```

## 打包

需先将 omp + bun 二进制放入 `resources/binaries/`（参见该目录 README），然后：

```sh
npm run package:win
```

## 里程碑

- **M0** 项目脚手架（当前）
- M1 omp RPC 核心
- M2 项目/存储/发现
- M3 仿真/终端
- M4 AI 辅助核心流
- M5 环境搭建/覆盖率
- M6 回归/dashboard/TO
- M7 MCP/skill 管理/凭据/打磨

## 布局

经典三栏 + 底部仿真选项浮窗：

- 左栏：项目文件树 + 用例树 + dashboard
- 中栏：多功能多页面区（终端 / AI 产物汇总 / 文件显示）
- 右栏：AI Agent 多会话 + 后台任务
- 底部：仿真 option 浮窗（插件 schema 动态生成，可展开收缩）
