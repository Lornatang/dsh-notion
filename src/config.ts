import z from '@deepseek-ai/schemastery'

export const DEFAULT_NOTION_URL = 'https://mcp.notion.com/mcp'

export interface Config {
  serverName: string
  url: string
  redirectPort: number
  toolCallTimeoutMs: number
  authorizationTimeoutMs: number
  autoOpenBrowser: boolean
}

export const Config = z.object({
  serverName: z.string().default('notion'),
  url: z.string().default(DEFAULT_NOTION_URL),
  redirectPort: z.number().step(1).min(0).max(65535).default(3335),
  // AbortSignal.timeout rejects values above the 32-bit signed millisecond limit.
  toolCallTimeoutMs: z.number().step(1).min(1).max(2_147_483_647).default(60000),
  authorizationTimeoutMs: z.number().step(1).min(1000).max(2_147_483_647).default(300000),
  autoOpenBrowser: z.boolean().default(false),
})
