import { readFileSync, existsSync } from "node:fs";
import { parse } from "yaml";
import { AppConfigSchema, type AppConfig } from "./schema.js";

/**
 * 加载并验证 YAML 配置文件。
 * 支持 ${VAR_NAME} 环境变量插值。
 */
export function loadConfig(configPath: string): AppConfig {
  if (!existsSync(configPath)) {
    console.warn(`配置文件 ${configPath} 不存在，使用默认配置`);
    return { server: { port: 3100, host: "0.0.0.0", auth: { excludePaths: ["/health"] } }, tools: [] };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parse(raw);

  if (!parsed || typeof parsed !== "object") {
    throw new Error("配置文件格式错误：不是有效的 YAML 对象");
  }

  // 递归插值环境变量
  interpolateEnvVars(parsed);

  const result = AppConfigSchema.safeParse(parsed);
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`配置验证失败:\n${errors}`);
  }

  return result.data;
}

/** 递归遍历对象，将 ${VAR_NAME} 替换为环境变量值 */
function interpolateEnvVars(obj: unknown): void {
  if (typeof obj === "string") {
    // 在字符串中替换所有 ${VAR_NAME} 模式
    return; // 字符串是值类型，无法原地修改，由调用者处理
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === "string") {
        obj[i] = interpolateString(obj[i] as string);
      } else if (obj[i] && typeof obj[i] === "object") {
        interpolateEnvVars(obj[i]);
      }
    }
  } else if (obj && typeof obj === "object") {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      const val = (obj as Record<string, unknown>)[key];
      if (typeof val === "string") {
        (obj as Record<string, unknown>)[key] = interpolateString(val);
      } else if (val && typeof val === "object") {
        interpolateEnvVars(val);
      }
    }
  }
}

function interpolateString(s: string): string {
  return s.replace(/\$\{(\w+)\}/g, (_, name) => {
    return process.env[name] ?? "";
  });
}