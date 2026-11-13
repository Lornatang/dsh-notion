import z from '@deepseek-ai/schemastery';
export declare const DEFAULT_NOTION_URL = "https://mcp.notion.com/mcp";
export interface Config {
    serverName: string;
    url: string;
    redirectPort: number;
    toolCallTimeoutMs: number;
    authorizationTimeoutMs: number;
    autoOpenBrowser: boolean;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    serverName: z<string, string, "defined">;
    url: z<string, string, "defined">;
    redirectPort: z<number, number, "defined">;
    toolCallTimeoutMs: z<number, number, "defined">;
    authorizationTimeoutMs: z<number, number, "defined">;
    autoOpenBrowser: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    serverName: z<string, string, "defined">;
    url: z<string, string, "defined">;
    redirectPort: z<number, number, "defined">;
    toolCallTimeoutMs: z<number, number, "defined">;
    authorizationTimeoutMs: z<number, number, "defined">;
    autoOpenBrowser: z<boolean, boolean, "defined">;
}>>, "plain">;
