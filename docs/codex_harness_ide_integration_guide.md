# 将 OpenAI Codex Harness 嵌入 IDE 项目：完整实战指南

> **背景**：2026 年 8 月 19-21 日，OpenAI 在 Apache-2.0 许可下全面开源了 Codex Harness。代码仓库：[github.com/openai/codex](https://github.com/openai/codex)

---

## 一、三种集成方式：选对入口

Codex Harness 开源了三大组件，IDE 集成应首选 **App Server**：

| 组件 | 适用场景 | 通信方式 | 特点 |
|------|---------|---------|------|
| `codex exec` | CI/CD、一次性脚本 | CLI 调用 | 每次冷启动，无状态 |
| **Codex SDK** (TS/Python) | 服务端自动化 | 函数调用 | 封装了部分协议，适合非交互场景 |
| **Codex App Server** ⭐ | **IDE 插件、桌面应用、富交互 UI** | **JSON-RPC over stdio** | 持久会话、流式事件、双向审批 |

> **结论**：IDE 项目必须走 **App Server** 路线，它是 VS Code 扩展、JetBrains 插件、Xcode 集成的官方方案。

---

## 二、核心架构：App Server 是什么

App Server 是一个**有状态的长生命周期进程**，通过 **JSON-RPC 2.0** 协议暴露 Codex 的 Agent 能力。

```
┌─────────────────┐     JSON-RPC (stdio/JSONL)     ┌──────────────────┐
│   你的 IDE 插件  │  ◄──────────────────────────►  │  codex app-server │
│  (VS Code/JetBrains│    双向流式通信                │  (Rust 核心进程)   │
│   /Xcode/自定义)   │                                │                  │
└─────────────────┘                                └──────────────────┘
                                                            │
                                                            ▼
                                                   ┌──────────────────┐
                                                   │   Codex Core     │
                                                   │ (Agent 循环核心)  │
                                                   └──────────────────┘
```

**关键设计**：
- 一个 App Server 进程管理多个 Thread（会话）
- 协议是**完全双向**的：客户端发请求，服务器也能主动发审批请求
- 传输默认用 **stdio**（每行一个 JSON 对象，省略 `"jsonrpc":"2.0"` 字段）

---

## 三、三步走：IDE 集成实战

### Step 1：安装 Codex CLI

```bash
# macOS / Linux
brew install openai-codex

# 或从源码构建
git clone https://github.com/openai/codex.git
cd codex && cargo build --release
```

验证：
```bash
codex --version
codex app-server --help
```

### Step 2：生成客户端类型定义

App Server 提供了 schema 生成工具，**强烈建议先用它生成类型**：

```bash
# 生成 TypeScript 定义（适合 VS Code 插件）
codex app-server generate-ts --out ./codex-types

# 生成 JSON Schema（适合其他语言）
codex app-server generate-json-schema --out ./codex-schema

# 如需实验性 API，加 --experimental 标志
codex app-server generate-ts --out ./codex-types --experimental
```

> ⚠️ **重要**：schema 与 Codex CLI 版本绑定。升级 CLI 后必须重新生成类型。

### Step 3：启动 App Server 并建立连接

在你的 IDE 插件中，启动 App Server 作为子进程：

```typescript
// VS Code 插件示例（TypeScript/Node.js）
import { spawn } from 'child_process';

const codexProcess = spawn('codex', ['app-server', '--stdio'], {
  env: { ...process.env, RUST_LOG: 'info' }
});

// 向 stdin 写入 JSON-RPC 请求
codexProcess.stdin.write(JSON.stringify({
  method: 'initialize',
  id: 0,
  params: {
    clientInfo: {
      name: 'my_ide_plugin',
      title: 'My IDE Plugin',
      version: '1.0.0'
    },
    capabilities: {
      experimentalApi: true  // 如需实验性功能
    }
  }
}) + '\n');

// 从 stdout 读取响应
codexProcess.stdout.on('data', (data) => {
  const lines = data.toString().trim().split('\n');
  for (const line of lines) {
    const message = JSON.parse(line);
    handleMessage(message);
  }
});
```

---

## 四、协议核心：Thread / Turn / Item

理解这三个原语是正确集成的前提：

### Thread（线程）—— 持久会话容器
- 一个 Thread = 一次完整的 Codex 对话
- 可以**创建、恢复、分叉、归档**
- 历史记录持久化，客户端断开后可重连

### Turn（轮次）—— 单次工作单元
- 一个 Turn = 用户输入 → Agent 完成输出
- 包含多个 Item（步骤）
- 典型生命周期：`turn/started` → 多个 Item 事件 → `turn/completed`

### Item（项）—— 原子输入/输出
- 每个 Item 有明确的生命周期：`item/started` → `item/*/delta`（可选流式）→ `item/completed`
- 类型包括：`userMessage`、`agentMessage`、`commandExecution`、`fileChange`、`reasoning` 等

```
Thread: "修复登录 Bug"
├── Turn 1: "调查这个问题"
│   ├── Item: userMessage ("调查这个问题")
│   ├── Item: reasoning (Agent 思考过程)
│   ├── Item: commandExecution (运行 git log)
│   ├── Item: commandExecution (读取 auth.ts)
│   └── Item: agentMessage ("发现是 token 过期逻辑错误")
│   └── turn/completed
│
├── Turn 2: "修复它"
│   ├── Item: userMessage ("修复它")
│   ├── Item: fileChange (修改 auth.ts)
│   ├── Item: commandExecution (运行测试)
│   └── Item: agentMessage ("已修复，测试通过")
│   └── turn/completed
```

---

## 五、完整交互流程示例

### 1. 初始化握手（必须）

```json
// 客户端发送
{
  "method": "initialize",
  "id": 0,
  "params": {
    "clientInfo": {
      "name": "my_ide_plugin",
      "title": "My IDE Plugin",
      "version": "1.0.0"
    }
  }
}

// 服务器响应
{
  "id": 0,
  "result": {
    "userAgent": "my_ide_plugin/1.0.0",
    "codexHome": "/Users/me/.codex",
    "platformFamily": "unix",
    "platformOs": "darwin"
  }
}

// 客户端发送确认通知（无 id）
{
  "method": "initialized",
  "params": {}
}
```

### 2. 创建 Thread

```json
// 请求
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "model": "gpt-5.6-sol",
    "cwd": "/Users/me/project",
    "approvalPolicy": "unlessTrusted",
    "sandbox": "workspaceWrite",
    "personality": "friendly"
  }
}

// 响应
{
  "id": 10,
  "result": {
    "thread": {
      "id": "thr_123",
      "preview": "",
      "modelProvider": "openai",
      "createdAt": 1730910000
    }
  }
}

// 服务器通知
{
  "method": "thread/started",
  "params": { "thread": { "id": "thr_123", "status": { "type": "idle" } } }
}
```

### 3. 启动 Turn（发送用户输入）

```json
// 请求
{
  "method": "turn/start",
  "id": 30,
  "params": {
    "threadId": "thr_123",
    "clientUserMessageId": "msg_001",
    "input": [
      { "type": "text", "text": "修复登录模块的 token 过期 bug" }
    ]
  }
}

// 响应（立即返回 Turn 对象）
{
  "id": 30,
  "result": {
    "turn": {
      "id": "turn_456",
      "status": "inProgress",
      "items": [],
      "error": null
    }
  }
}
```

### 4. 处理流式事件

Turn 启动后，服务器会持续推送通知：

```json
// Turn 开始
{ "method": "turn/started", "params": { "turn": { "id": "turn_456", "status": "inProgress" } } }

// Agent 开始推理
{ "method": "item/started", "params": { "item": { "type": "reasoning", "id": "item_1", "summary": "" } } }
{ "method": "item/reasoning/summaryTextDelta", "params": { "itemId": "item_1", "delta": "正在分析登录模块...", "summaryIndex": 0 } }

// Agent 执行命令
{ "method": "item/started", "params": { "item": { "type": "commandExecution", "id": "item_2", "command": ["git", "log", "--oneline", "-5"], "status": "inProgress" } } }
{ "method": "item/commandExecution/outputDelta", "params": { "itemId": "item_2", "stream": "stdout", "deltaBase64": "YWJjZDEyMyBGaXggdG9rZW4gaXNzdWU=" } }
{ "method": "item/completed", "params": { "item": { "type": "commandExecution", "id": "item_2", "status": "completed", "exitCode": 0 } } }

// Agent 修改文件
{ "method": "item/started", "params": { "item": { "type": "fileChange", "id": "item_3", "changes": [...], "status": "inProgress" } } }

// 关键：如果配置需要审批，服务器会主动发请求
{
  "method": "item/fileChange/requestApproval",
  "id": 61,
  "params": {
    "threadId": "thr_123",
    "turnId": "turn_456",
    "itemId": "item_3",
    "reason": "Agent wants to edit auth.ts"
  }
}

// 客户端必须响应审批请求
{
  "id": 61,
  "result": { "decision": "accept" }
}

// Agent 最终消息
{ "method": "item/started", "params": { "item": { "type": "agentMessage", "id": "item_4", "text": "" } } }
{ "method": "item/agentMessage/delta", "params": { "itemId": "item_4", "delta": "已修复 token 过期逻辑" } }
{ "method": "item/completed", "params": { "item": { "type": "agentMessage", "id": "item_4", "text": "已修复 token 过期逻辑，测试通过。" } } }

// Turn 完成
{ "method": "turn/completed", "params": { "turn": { "id": "turn_456", "status": "completed", "items": [...] } } }
```

### 5. 恢复历史会话

```json
{
  "method": "thread/resume",
  "id": 11,
  "params": { "threadId": "thr_123" }
}
```

### 6. 打断正在运行的 Turn

```json
{
  "method": "turn/interrupt",
  "id": 31,
  "params": { "threadId": "thr_123", "turnId": "turn_456" }
}
```

---

## 六、IDE 集成的关键设计决策

### 1. 审批 UI（Human-in-the-loop）

App Server 的**核心特性**是服务器可以主动发起审批请求。IDE 必须实现：

- **命令执行审批**：`item/commandExecution/requestApproval`
- **文件修改审批**：`item/fileChange/requestApproval`
- **权限请求**：`item/permissions/requestApproval`

响应格式：
```json
{ "id": 61, "result": { "decision": "accept" } }
// 或 "acceptForSession" / "decline" / "cancel"
```

### 2. 沙箱与权限策略

| 策略 | 说明 | 适用场景 |
|------|------|---------|
| `read-only` | 只读，不修改文件 | 代码审查、调研 |
| `workspaceWrite` | 可修改工作区文件 | 日常开发 |
| `dangerFullAccess` | 完全访问（慎用）| 系统级操作 |

在 `thread/start` 或 `turn/start` 中设置：
```json
{ "approvalPolicy": "unlessTrusted", "sandbox": "workspaceWrite" }
```

### 3. 会话持久化

- Thread 历史自动持久化到 `~/.codex/sessions/`
- 使用 `thread/list` 获取历史会话列表
- 使用 `thread/resume` 恢复指定会话
- 使用 `thread/fork` 从现有会话分叉（类似分支）

### 4. 多线程管理

IDE 可以同时管理多个 Thread：
- 每个工作区/项目一个 Thread
- 使用 `thread/loaded/list` 查看内存中的活跃会话
- 使用 `thread/unsubscribe` 取消订阅，30 分钟无活动后自动卸载

---

## 七、Python SDK 快速接入

如果不想手写 JSON-RPC，可以用官方 Python SDK：

```bash
pip install openai-codex-app-server-sdk
```

```python
from codex_app_server import Codex
from codex_app_server.config import AppServerConfig

with Codex(config=AppServerConfig()) as codex:
    # 创建线程
    thread = codex.start_thread(
        model="gpt-5.6-sol",
        cwd="/Users/me/project",
        approval_policy="unlessTrusted",
        sandbox="workspaceWrite"
    )

    # 启动 Turn
    result = thread.run("修复登录模块的 token 过期 bug")

    # 遍历事件
    for event in result.events:
        print(event)
```

> SDK 封装了子进程管理和协议解析，但底层仍是同样的 JSON-RPC。

---

## 八、最佳实践与避坑指南

### ✅ Do
- **总是先 `initialize` 再发其他请求**，否则收到 `"Not initialized"` 错误
- **处理 `serverRequest/resolved` 通知**，确认审批请求已被清理
- **使用 `clientUserMessageId`** 关联用户消息，方便 UI 渲染
- **监听 `thread/status/changed`** 跟踪会话状态（idle/active/systemError）
- **对 `-32001` 错误做指数退避重试**（服务器过载）
- **固定 Codex CLI 版本**，升级时重新生成 schema

### ❌ Don't
- 不要试图用单个 App Server 进程服务多租户（它是单用户设计）
- 不要忽略服务器发起的请求（如审批），否则 Turn 会挂起
- 不要在生产环境依赖 WebSocket 传输（标记为实验性/不支持）
- 不要混用 `sandbox` 和 `permissions` 字段（二选一）

### ⚠️ 版本兼容性
- App Server 协议会随版本演进，但保持**向后兼容**
- 实验性 API 需要 `capabilities.experimentalApi = true`
- 实验性方法/字段可能在未来版本中变化

---

## 九、参考资源

| 资源 | 链接 |
|------|------|
| 官方仓库 | https://github.com/openai/codex |
| App Server README | `codex/codex-rs/app-server/README.md` |
| 官方博客：Unlocking the Codex Harness | https://openai.com/index/unlocking-the-codex-harness/ |
| 开发者指南（Gist）| https://gist.github.com/oneryalcin/ee2c27e2d8aa040da8fbe7eebcc2ecea |
| Python SDK | `pip install openai-codex-app-server-sdk` |

---

## 十、快速启动检查清单

- [ ] 安装 `codex` CLI 并验证 `codex app-server --help`
- [ ] 运行 `codex app-server generate-ts --out ./types` 生成类型
- [ ] 在 IDE 插件中 spawn `codex app-server --stdio` 子进程
- [ ] 实现 `initialize` / `initialized` 握手
- [ ] 实现 `thread/start` 创建会话
- [ ] 实现 `turn/start` 发送用户输入
- [ ] 实现事件循环处理 `item/*` 和 `turn/*` 通知
- [ ] 实现审批请求响应（`item/*/requestApproval`）
- [ ] 实现 `thread/resume` 恢复历史会话
- [ ] 测试 `turn/interrupt` 打断功能
