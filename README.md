# trpc-cli-demo

基于 [trpc-cli](https://github.com/mmkal/trpc-cli) + [@bomb.sh/tab](https://bomb.sh/tab) + [@clack/prompts](https://github.com/natclark/clack) 的 CLI 集成测试项目，主要验证以下三个框架的功能与可用性：

- **trpc-cli** — 将 tRPC router 转为命令行工具
- **@bomb.sh/tab** — Shell 自动补全（zsh/bash/fish/powershell）
- **@clack/prompts** — 交互式命令行提示

## 技术栈

- **tRPC** — 类型安全的路由定义
- **trpc-cli** — 将 tRPC router 转为 Commander.js CLI
- **@bomb.sh/tab** — Shell 自动补全框架（支持 zsh/bash/fish/powershell）
- **Zod** — 输入校验与 schema 定义

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式运行（tsx，无需编译）
pnpm dev -- add --left 1 --right 2

# 编译
pnpm build
```

## 自动补全集成

### 原理

trpc-cli 内部基于 Commander.js 构建，提供 `buildProgram()` API 获取 Commander 实例。@bomb.sh/tab 的 Commander 适配器可以读取该实例的命令/选项结构，自动生成 shell 补全脚本。

### 关键代码

```ts
const cli = createCli({ router, name: 'trpc-cli-demo' })

// 1. 获取 Commander 实例
const program = cli.buildProgram()
// 2. 用 @bomb.sh/tab 注册补全
tab(program as any)
// 3. 将同一个 program 传回 run()
cli.run({ prompts }, program)
```

### 注意事项

1. **必须显式设置 `name`**：`createCli({ router, name: 'trpc-cli-demo' })` — 未设置时 Commander 的 `program.name()` 为空，导致补全脚本中 `#compdef` 和 `compdef` 缺少命令名
2. **`buildProgram()` 和 `run()` 必须配对**：`run()` 接受第二个参数 `program`，如果不传，`run()` 会内部重新创建 Commander 实例，导致 tab 注册的补全命令丢失
3. **bin 脚本必须使用 Node.js 形式**：不能用 bash wrapper + `exec node`，否则 `process.argv[1]` 会变成 JS 文件路径而非命令名（虽然显式设置 `name` 后此问题已不影响补全，但 Node.js bin 在跨平台兼容性上更优）

### bin 脚本设计

`bin/trpc-cli-demo` 采用 Node.js 脚本形式：

```js
#!/usr/bin/env node
import('../dist/index.js')
```

- pnpm 在 Windows 上会自动生成 `.cmd` 包装文件，跨平台兼容
- 避免使用 bash wrapper，Windows 原生不支持

## 交互式提示（Prompts）

trpc-cli 支持在缺少参数时通过交互式提示引导用户输入。本项目使用 `@clack/prompts` 作为提示引擎。

```ts
cli.run({
    prompts: isAgent() ? null : prompts,
}, program)
```

### `isAgent()` 智能检测

`isAgent()` 是 trpc-cli 提供的工具函数，用于检测当前是否运行在 AI Agent 环境中（如 Claude Code、Cursor 等）：

- **普通终端**：`isAgent()` 返回 `false`，启用 `@clack/prompts`，缺失参数时弹出交互式提示
- **AI Agent 环境**：`isAgent()` 返回 `true`，`prompts` 设为 `null`，禁用交互提示，避免 Agent 调用时卡死

### 支持的 prompts 引擎

trpc-cli 兼容多种 prompts 库，通过 `prompts` 参数传入：

| 库 | 说明 |
|---|---|
| `@clack/prompts` | 本项目使用，UI 美观，支持 intro/outro |
| `@inquirer/prompts` | 社区流行的交互式提示库 |
| `prompts` | 轻量级，API 简洁 |
| `enquirer` | 功能丰富，支持自定义组件 |

也可以传入 `boolean`：`true` 使用 trpc-cli 内置的默认 prompts，`false`/`null` 禁用。

## 测试流程

### 1. 编译并全局安装

```bash
pnpm build
pnpm install -g .
```

### 2. 验证命令可用

```bash
trpc-cli-demo --help
trpc-cli-demo add --left 1 --right 2
```

### 3. 注册 zsh 补全

```bash
eval "$(trpc-cli-demo complete zsh)"
```

### 4. 测试补全

```bash
trpc-cli-demo <TAB>            # 应显示子命令：add, complete
trpc-cli-demo add --<TAB>      # 应显示选项：--left, --right, --help
```

### 5. 持久化补全（可选）

```bash
trpc-cli-demo complete zsh > ~/.trpc-cli-demo-completion.zsh
echo 'source ~/.trpc-cli-demo-completion.zsh' >> ~/.zshrc
```

### 6. 卸载

```bash
pnpm remove -g trpc-cli-demo
```

> **注意**：撤销全局安装使用 `pnpm remove -g`，而非 `pnpm unlink --global`（后者可能不生效）。

## 常见问题

### Q: `pnpm install -g .` 后找不到命令

pnpm 全局 bin 目录可能不在 PATH 中。运行 `pnpm bin --global` 查看路径，将其添加到 `~/.zshrc`：

```bash
export PATH="$(pnpm bin --global):$PATH"
```

