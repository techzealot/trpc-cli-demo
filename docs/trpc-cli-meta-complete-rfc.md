# trpc-cli 声明式候选值机制设计（RFC）

## 背景

当前 trpc-cli 使用 [Omelette](https://github.com/f/omelette) 作为补全引擎，但该库已长期未更新。[@bomb.sh/tab](https://bomb.sh/tab) 是新一代的 JS CLI 补全框架，已被 Cloudflare、Nuxt、Vitest 等项目采用，支持 zsh/bash/fish/powershell。

本文档设计 trpc-cli 的**声明式候选值机制**，通过 `meta.complete` 统一声明字段候选值，同时服务于 **Tab 补全**、**Prompts 交互** 和 **输入验证**。

## 现状分析

### 当前 Omelette 集成方式

```ts
// 用户需要自行创建 Omelette 实例并传入
import omelette from 'omelette'
const cli = createCli({ router })
cli.run({ completion: omelette('myprogram') })
```

问题：
- Omelette 长期未维护
- 用户需要额外安装和配置 Omelette
- 补全逻辑和 schema 定义分离，缺乏声明式关联
- `buildProgram()` 和 `run()` 的实例配对问题容易踩坑

### 当前 @bomb.sh/tab 集成方式（外部集成）

```ts
const program = cli.buildProgram()
tab(program as any)
cli.run(params, program)
```

问题：
- 需要理解 buildProgram/run 配对机制
- Commander 实例需要 `as any` 类型断言
- 没有自定义补全的入口

## 设计目标

1. **统一候选值**：`meta.complete` 声明的候选值同时服务于 Tab 补全和 Prompts 交互
2. **Schema 驱动**：候选值在 Zod schema 上声明，符合 tRPC 的 schema-driven 理念
3. **统一机制**：`meta.complete` 映射到 `option.choices()`，Tab / Prompts / 验证 / 帮助文本四端免费
4. **渐进式复杂度**：L0 自动 → L1 静态 → L2 描述 → L3 动态，按需选择
5. **向后兼容**：新增字段均为可选，不影响现有行为
6. **一行启用**：用户只需 `cli.run({ tab: true })`

## 核心设计：统一机制

`meta.complete` 的值统一映射到 Commander 的 `option.choices()`，由 `argChoices` 驱动所有消费端：

```
meta.complete / getEnumChoices
  ↓
Commander option.choices([...])
  ↓ argChoices
┌────────────────────┬──────────────────────────────────────┐
│ 消费端             │ 行为                                 │
├────────────────────┼──────────────────────────────────────┤
│ Commander 验证     │ 拒绝不在 choices 中的输入            │
│ Commander --help   │ 显示 (choices: "dev", "prod")        │
│ Tab 补全           │ 读取 argChoices → 候选值             │
│ Prompts            │ 读取 argChoices → select 菜单        │
└────────────────────┴──────────────────────────────────────┘
```

验证由 Commander 和 Zod **双重保障**，语义一致时不冲突。如果需要开放输入，直接使用 `z.string()` 不声明 `complete` 即可。

## 候选值层次

### L0 — 自动推导（已实现）

trpc-cli 在 `buildProgram()` 时通过内部工具函数 `getEnumChoices()` 从 JSON Schema 中提取枚举候选值，映射到 Commander 的 `option.choices()`。Tab 和 Prompts **零配置即可生效**。

#### 支持类型

| Zod 类型 | 示例 | JSON Schema 模式 | 效果 |
|---|---|---|---|
| `z.enum()` | `z.enum(['dev', 'prod'])` | `{ enum: ['dev', 'prod'] }` | Tab 补全 + Prompts select |
| `z.union()` 字面量 | `z.union([z.literal('a'), z.literal('b')])` | `{ enum: ['a', 'b'] }` | 同上 |
| Zod 4 `anyOf` + `const` | Zod 4 内部生成 | `{ anyOf: [{ const: 'a' }, ...] }` | 同上 |
| `z.nativeEnum()` | `z.nativeEnum({ A: 'a', B: 'b' })` | `{ enum: ['a', 'b'] }` | 同上 |
| `z.array(z.enum())` | `z.array(z.enum(['x', 'y']))` | 元素含 `enum` | Tab 补全 + Prompts checkbox |
| `z.boolean()` | `z.boolean()` | — | 自动生成 `--no-*` 取反选项 |
| 子命令名 | router procedure 名称 | — | Commander 子命令补全 |

#### 实现机制

```
Zod schema
  ↓ zod-to-json-schema（内置实现，按 ZodFirstPartyTypeKind 分派）
JSON Schema（{ enum: [...] } 或 { anyOf: [{ const: ... }] }）
  ↓ getEnumChoices() 识别枚举模式
{ type: 'string_enum', choices: ['a', 'b', 'c'] }
  ↓ Commander option.choices(['a', 'b', 'c'])
  ↓ argChoices
  ├── @bomb.sh/tab 读取 → Tab 补全
  └── prompts.js 读取 → select 菜单 / checkbox 多选
```

`getEnumChoices` 识别两种 JSON Schema 模式：
1. `{ enum: ['a', 'b'] }` — 标准 JSON Schema enum
2. `{ anyOf: [{ const: 'a' }, { const: 'b' }] }` — ArkType / Zod 4 风格

`zod-to-json-schema` 是 trpc-cli 内置打包的实现（非外部依赖），按 Zod 类型做 switch 分派，每种类型有对应的 parser（如 `parseEnumDef`、`parseStringDef` 等）。

#### 不支持类型

| Zod 类型 | 原因 |
|---|---|
| `z.string()` | 无限值域，无候选项 |
| `z.number()` | 无限值域 |
| `z.date()` | 无候选项 |
| `z.object()` | 复杂结构，走 `--json` |
| `z.array(z.string())` | 数组元素开放 |

### L1~L3 — 声明式候选值（设计提案）

#### 使用示例

```ts
const router = t.router({
    deploy: t.procedure
        .input(z.object({
            // L0: enum 自动推导（已支持）
            env: z.enum(['dev', 'staging', 'prod']),

            // L1: 静态候选（映射到 choices，约束 + 补全 + 提示）
            region: z.string().meta({
                complete: ['us-east-1', 'us-west-2', 'ap-southeast-1']
            }),

            // L2: 带描述的静态候选
            profile: z.string().meta({
                complete: [
                    { value: 'default', description: '默认配置' },
                    { value: 'prod', description: '生产配置' },
                ]
            }),

            // L3: 动态候选（运行时函数）
            branch: z.string().meta({
                complete: async () => {
                    const { stdout } = await exec('git branch --list')
                    return stdout.split('\n').map(b => b.trim())
                }
            }),

            // L3+: 带上下文的动态候选
            file: z.string().meta({
                complete: async (ctx) => {
                    const dir = ctx.options.project || '.'
                    return await listFiles(dir)
                }
            }),
        }))
        .mutation(({ input }) => { /* ... */ })
})
```

#### 静态与动态的处理差异

| 层次 | choices 注册 | 验证 | Tab | Prompts |
|---|---|---|---|---|
| L0 enum | `option.choices()` | Commander + Zod 双重 | argChoices 自动补全 | argChoices → select |
| L1/L2 静态 | `option.choices()` | Commander + Zod 双重 | argChoices 自动补全 | argChoices → select |
| L3 动态 | 不注册 | 仅 Zod | complete -- 时调用函数 | 缺失参数时调用函数 |

L0/L1/L2 统一走 `option.choices()`，Commander 验证和 Zod 验证语义一致，不冲突。L3 不注册 `choices` 的原因：候选值是运行时动态生成的，无法在 schema 解析阶段确定。

#### Prompts 侧增强

```ts
// prompts.js 增强逻辑
if (option.original.argChoices) {
    // L0/L1/L2 静态候选：直接显示选择菜单
    const promptedValue = await prompter.select({
        message: getMessage(option.original),
        choices: option.original.argChoices,
        default: defaultValue,
    }, ctx)
} else if (meta?.complete && typeof meta.complete === 'function') {
    // L3 动态候选：异步加载后渲染选择菜单
    const items = await meta.complete(buildCompleteContext(ctx))
    const promptedValue = await prompter.select({
        message: getMessage(option.original),
        choices: items.map(i => normalizeItem(i)),
    }, ctx)
} else {
    // 无候选：自由输入
    const promptedValue = await prompter.input({
        message: getMessage(option.original),
    }, ctx)
}
```

#### 启用方式

```ts
// 用户只需一行配置
cli.run({ tab: true })

// 或自定义 complete 子命令名
cli.run({ tab: { completionCommandName: 'completions' } })
```

## 类型定义

### Zod meta 扩展

```ts
declare module 'zod' {
    interface GlobalMeta {
        /**
         * 为该字段声明候选值。
         * 映射到 Commander option.choices()，同时服务于：
         * Tab 补全 / Prompts 交互 / 输入验证 / --help 显示
         *
         * - string[]: 静态值列表（L1）
         * - CompleteItem[]: 带描述的列表（L2）
         * - CompleteFn: 同步/异步函数，运行时动态生成（L3）
         */
        complete?: string[] | CompleteItem[] | CompleteFn
    }
}
```

### 候选值相关类型

```ts
interface CompleteItem {
    value: string
    description?: string
}

type CompleteFn = (ctx: CompleteContext) =>
    | (string | CompleteItem)[]
    | Promise<(string | CompleteItem)[]>

interface CompleteContext {
    /** 当前已输入的选项值 */
    options: Record<string, unknown>
    /** 当前正在补全的字段名 */
    field: string
    /** 已输入的部分值 */
    partial: string
}
```

### RunParams 扩展

```ts
type TrpcCliRunParams = {
    // ... 现有字段 ...

    /**
     * 启用 @bomb.sh/tab 补全支持。
     * - true: 使用默认配置
     * - object: 自定义配置
     *
     * 需要安装 @bomb.sh/tab 作为依赖（optional peer dependency）。
     */
    tab?: boolean | {
        /** 补全脚本生成命令的名称，默认 'complete' */
        completionCommandName?: string
    }

    /** @deprecated 使用 tab 代替 */
    completion?: OmeletteInstanceLike | (() => Promise<OmeletteInstanceLike>)
}
```

## 内部实现

### buildProgram 中的候选值注册

```ts
function buildProgram(runParams) {
    const program = new Command(params.name)
    // ... 现有命令构建逻辑 ...

    if (runParams?.tab) {
        // 动态 import，不安装时不影响主流程
        const tab = await import('@bomb.sh/tab/commander')
        const tabRoot = tab.default(program,
            typeof runParams.tab === 'object' ? runParams.tab : {}
        )

        // 遍历所有命令，将 meta.complete 映射到 tab handler
        for (const command of walkCommands(program)) {
            const tabCommand = tabRoot.commands.get(command.name())
            if (!tabCommand) continue

            for (const option of command.options) {
                const meta = getOptionMeta(option)
                if (!meta?.complete) continue

                tabCommand.option(
                    option.long?.slice(2),
                    option.description,
                    createTabHandler(meta.complete)
                )
            }
        }
    }

    return program
}

function createTabHandler(complete) {
    if (Array.isArray(complete)) {
        // L1/L2: 静态建议
        return (completeFn) => {
            for (const item of normalizeItems(complete)) {
                completeFn(item.value, item.description || '')
            }
        }
    }
    // L3: 动态函数
    return async (completeFn, optionsMap) => {
        const ctx = buildCompleteContext(optionsMap)
        const items = await complete(ctx)
        for (const item of normalizeItems(items)) {
            completeFn(item.value, item.description || '')
        }
    }
}
```

### 依赖管理

`@bomb.sh/tab` 作为 optional peer dependency：

```json
{
    "peerDependencies": {
        "@bomb.sh/tab": "^0.0.17"
    },
    "peerDependenciesMeta": {
        "@bomb.sh/tab": {
            "optional": true
        }
    }
}
```

当 `tab: true` 但未安装时，抛出明确错误：

```
Error: tab completion requires @bomb.sh/tab to be installed.
Run: npm install @bomb.sh/tab
```

## 迁移路径

### 从 Omelette 迁移

```ts
// Before (Omelette)
import omelette from 'omelette'
cli.run({ completion: omelette('myprogram') })

// After (tab)
cli.run({ tab: true })
```

### 从外部 tab 集成迁移

```ts
// Before (手动集成)
import tab from '@bomb.sh/tab/commander'
const program = cli.buildProgram()
tab(program as any)
cli.run(params, program)

// After (内置支持)
cli.run({ tab: true })
```

## 开放问题

1. **L3 动态补全的执行环境**：补全函数在 `complete --` 子命令进程中执行，如何安全地访问项目上下文（如读取 git 信息）？
2. **补全缓存**：动态补全可能较慢（如 API 调用），是否需要缓存机制？
3. **与 Omelette 共存**：过渡期是否需要同时支持两种引擎，还是直接替换？
4. **bin 脚本规范**：是否需要 trpc-cli 提供标准的 bin 脚本模板，确保 `process.argv` 和命令名正确？
5. **Prompts 动态加载 UX**：L3 动态候选异步加载时，是否需要 loading 提示？
