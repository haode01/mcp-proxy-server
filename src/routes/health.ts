import type { FastifyInstance } from "fastify";
import type { ProxyManager } from "../proxy/ProxyManager.js";

/**
 * 注册健康检查和状态路由。
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  proxyManager: ProxyManager
): void {
  // GET /health — 健康检查
  app.get("/health", async () => {
    const infos = proxyManager.getProxyInfos();
    const running = infos.filter((i) => i.status === "running").length;
    const total = infos.length;

    return {
      status: running === total && total > 0 ? "healthy" : "degraded",
      uptime: process.uptime(),
      proxies: {
        total,
        running,
        failed: total - running,
      },
    };
  });

  // GET /tools — 列出所有已注册工具
  app.get("/tools", async () => {
    const infos = proxyManager.getProxyInfos();
    return {
      tools: infos.map((info) => ({
        name: info.name,
        description: info.description,
        status: info.status,
        toolCount: info.tools.length,
        tools: info.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })),
    };
  });
}