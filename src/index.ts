import Fastify from "fastify";
import cors from "@fastify/cors";
import { loadConfig } from "./config/loader.js";
import { ProxyManager } from "./proxy/ProxyManager.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerHealthRoutes } from "./routes/health.js";

async function main() {
  // 解析命令行参数
  const configPath = process.argv[2] || "./config.yaml";
  console.log(`加载配置文件: ${configPath}`);

  // 加载配置
  let config;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error("配置加载失败:", err);
    process.exit(1);
  }

  if (config.tools.length === 0) {
    console.warn("警告: 配置中没有定义任何工具");
  } else {
    console.log(`发现 ${config.tools.length} 个工具配置`);
  }

  // 初始化代理管理器
  const proxyManager = new ProxyManager();
  try {
    await proxyManager.initialize(config.tools);
  } catch (err) {
    console.error("代理初始化失败:", err);
    process.exit(1);
  }

  // 创建 HTTP 服务器
  const app = Fastify({
    logger: {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
    },
  });

  // 注册 CORS
  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

  // 注册鉴权中间件
  if (config.server.auth?.token) {
    const authToken = config.server.auth.token;
    const excludePaths = config.server.auth.excludePaths ?? ["/health"];

    app.addHook("onRequest", async (request, reply) => {
      // 检查是否在排除列表中
      for (const prefix of excludePaths) {
        if (request.url.startsWith(prefix)) return;
      }

      const auth = request.headers.authorization;
      if (auth !== `Bearer ${authToken}`) {
        reply.code(401).send({ error: "Unauthorized" });
        return; // 阻止后续处理
      }
    });
  }

  // 注册路由
  registerMcpRoutes(app, proxyManager);
  registerHealthRoutes(app, proxyManager);

  // 优雅关闭 — 带超时
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      console.log(`\n收到重复信号 ${signal}，强制退出`);
      process.exit(1);
    }
    shuttingDown = true;

    console.log(`\n收到 ${signal}，正在优雅关闭...`);

    // 先停止接受新请求
    await app.close();

    // 再关闭所有子进程
    await Promise.race([
      proxyManager.shutdown(),
      new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn("关闭超时，强制退出");
          resolve();
        }, 10_000);
      }),
    ]);

    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // 启动服务器
  try {
    const address = await app.listen({
      port: config.server.port,
      host: config.server.host,
    });
    console.log(`🚀 romate-mcp-server 已启动: ${address}`);
    console.log(`   健康检查: ${address}/health`);
    console.log(`   工具列表: ${address}/tools`);
    console.log(`   单工具 MCP: ${address}/mcp/:toolName`);
    console.log(`   单工具 SSE: ${address}/mcp/:toolName/sse`);
    console.log(`   聚合 MCP: ${address}/mcp`);
    console.log(`   聚合 SSE: ${address}/mcp/sse`);

    // 配置热重载 — 监听配置文件变化
    const fs = await import("fs");
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    fs.watch(configPath, (eventType) => {
      if (eventType !== "change") return;

      // 防抖：500ms 内多次变更只触发一次重载
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(async () => {
        console.log(`\n[hot-reload] 检测到配置文件变更，重新加载...`);
        try {
          const newConfig = loadConfig(configPath);
          const result = await proxyManager.reload(newConfig.tools);
          console.log(`[hot-reload] 完成: 新增=${result.added.length}, 移除=${result.removed.length}, 更新=${result.updated.length}, 错误=${result.errors.length}`);
          if (result.errors.length > 0) {
            console.error(`[hot-reload] 错误详情:`, result.errors);
          }
        } catch (err) {
          console.error(`[hot-reload] 重载失败:`, err);
        }
      }, 500);
    });
    console.log(`   配置热重载: 已启用 (监听 ${configPath})`);
  } catch (err) {
    console.error("服务器启动失败:", err);
    await proxyManager.shutdown();
    process.exit(1);
  }
}

main();