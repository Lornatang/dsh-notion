import type { Context } from '@deepseek-ai/cordis';
import { Config, type Config as Settings } from './config.js';
export declare const name = "notion";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: Context, config: Settings): void;
