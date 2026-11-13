import z from '@deepseek-ai/schemastery';
export const DEFAULT_NOTION_URL = 'https://mcp.notion.com/mcp';
export const Config = z.object({
    serverName: z.string().default('notion'),
    url: z.string().default(DEFAULT_NOTION_URL),
    redirectPort: z.number().step(1).min(0).max(65535).default(3335),
    toolCallTimeoutMs: z.number().step(1).min(1).default(60000),
    authorizationTimeoutMs: z.number().step(1).min(1000).default(300000),
    autoOpenBrowser: z.boolean().default(false),
});
