import { z } from "zod";

/** 单个工具的配置 schema */
export const ToolConfigSchema = z.object({
  name: z.string().min(1, "工具名称不能为空"),
  description: z.string().optional().default(""),
  command: z.string().min(1, "命令不能为空"),
  args: z.array(z.string()).optional().default([]),
  env: z.record(z.string()).optional().default({}),
  cwd: z.string().optional(),
  restart: z.boolean().optional().default(true),
  restartDelay: z.number().nonnegative().optional().default(2000),
});

export type ToolConfig = z.infer<typeof ToolConfigSchema>;

/** 服务器配置 schema */
export const ServerConfigSchema = z.object({
  port: z.number().int().positive().optional().default(3100),
  host: z.string().optional().default("0.0.0.0"),
  auth: z
    .object({
      token: z.string().optional(),
      /** 允许无需鉴权的路径前缀 */
      excludePaths: z.array(z.string()).optional().default(["/health"]),
    })
    .optional()
    .default({}),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;

/** 完整配置 schema */
export const AppConfigSchema = z.object({
  server: ServerConfigSchema.optional().default({}),
  tools: z.array(ToolConfigSchema).optional().default([]),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;