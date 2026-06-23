import tab from '@bomb.sh/tab/commander'
import * as prompts from '@clack/prompts'
import { initTRPC } from '@trpc/server'
import { createCli, isAgent } from 'trpc-cli'
import { z } from 'zod'

const t = initTRPC.create()

const router = t.router({
    add: t.procedure
        .input(z.object({
            left: z.number().describe("left operand"),
            right: z.number().describe("right operand"),
            choice: z.enum(['a', 'b']).describe("choice"),
        }
        )
        )
        .query(({ input }) => input.left + input.right),
})

const cli = createCli({ router, name: 'trpc-cli-demo' });

// 拿到 Commander 实例，用 @bomb.sh/tab 注册自动补全
const program = cli.buildProgram();
tab(program as any);

// 将同一个 program 传回 run()，确保 tab 注册的补全生效
cli.run({
    prompts: isAgent() ? null : prompts,
}, program)