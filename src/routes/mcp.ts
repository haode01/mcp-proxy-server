import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ProxyManager } from "../proxy/ProxyManager.js";
import type { McpProxy } from "../proxy/McpProxy.js";

// SSE 会话：保存客户端连接和待处理的消息队列
interface SseSession {
  id: string;
  reply: FastifyReply;
  messageQueue: Array<{ resolve: (value: unknown) => void; reject: (err: Error) => void }>;
}

let sseSessionCounter = 0;
const sseSessions = new Map<string, SseSession>();

/**
 * 注册 MCP 代理路由。
 * 每个工具通过 /mcp/:toolName 路径暴露。
 * 聚合模式通过 /mcp (无 toolName) 暴露。
 */
export function registerMcpRoutes(
  app: FastifyInstance,
  proxyManager: ProxyManager
): void {
  // ==================== 聚合 SSE 端点 ====================
  // GET /mcp/sse — 聚合所有工具的 SSE 连接
  app.get(
    "/mcp/sse",
    async (
      request: FastifyRequest,
      reply: FastifyReply
    ) => {
      const allProxies = proxyManager.getAllProxies();
      if (allProxies.size === 0) {
        return reply.code(404).send({ error: "没有可用的工具" });
      }

      const sessionId = `agg-${++sseSessionCounter}`;

      // 设置 SSE 响应头
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // 发送 endpoint 事件 — 使用完整 URL（MCP 协议要求）
      const protocol = request.protocol || "http";
      const host = request.headers.host || request.hostname;
      const endpointUrl = `${protocol}://${host}/mcp/message?sessionId=${sessionId}`;
      reply.raw.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

      // 聚合所有工具，用 proxyName_toolName 前缀区分
      const aggregatedTools = proxyManager.aggregateTools();
      reply.raw.write(`event: tools_list\ndata: ${JSON.stringify(aggregatedTools)}\n\n`);

      // 聚合所有资源
      const allResources: Array<{ proxyName: string; uri: string; name?: string; description?: string }> = [];
      for (const [proxyName, proxy] of allProxies) {
        for (const r of proxy.resources) {
          allResources.push({ proxyName, ...r });
        }
      }
      if (allResources.length > 0) {
        reply.raw.write(`event: resources_list\ndata: ${JSON.stringify(allResources)}\n\n`);
      }

      // 聚合所有提示词
      const allPrompts: Array<{ proxyName: string; name: string; description?: string }> = [];
      for (const [proxyName, proxy] of allProxies) {
        for (const p of proxy.prompts) {
          allPrompts.push({ proxyName, ...p });
        }
      }
      if (allPrompts.length > 0) {
        reply.raw.write(`event: prompts_list\ndata: ${JSON.stringify(allPrompts)}\n\n`);
      }

      // 创建会话
      const session: SseSession = {
        id: sessionId,
        reply,
        messageQueue: [],
      };
      sseSessions.set(sessionId, session);

      // 保持连接
      const keepAlive = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      request.raw.on("close", () => {
        clearInterval(keepAlive);
        sseSessions.delete(sessionId);
        for (const pending of session.messageQueue) {
          pending.reject(new Error("SSE 连接已关闭"));
        }
        session.messageQueue = [];
      });
    }
  );

  // ==================== 聚合消息端点 ====================
  // POST /mcp/message?sessionId=xxx — 聚合模式的消息接收
  app.post(
    "/mcp/message",
    async (
      request: FastifyRequest<{
        Querystring: { sessionId?: string };
      }>,
      reply: FastifyReply
    ) => {
      const sessionId = request.query.sessionId;

      if (!sessionId || !sseSessions.has(sessionId)) {
        return reply.code(404).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "SSE 会话未找到或已过期" },
          id: null,
        });
      }

      const body = request.body as Record<string, unknown>;
      const method = body?.method as string | undefined;

      if (!method) {
        return reply.code(400).send({
          jsonrpc: "2.0",
          error: { code: -32600, message: "缺少 method 字段" },
          id: body?.id ?? null,
        });
      }

      try {
        const result = await handleAggregatedRequest(proxyManager, method, body);

        const session = sseSessions.get(sessionId)!;
        session.reply.raw.write(`event: message\ndata: ${JSON.stringify(result)}\n\n`);

        return reply.code(202).send({ accepted: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[aggregate] 请求失败:`, message);

        const session = sseSessions.get(sessionId);
        if (session) {
          const errorData = JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message },
            id: (body?.id as number | string | null) ?? null,
          });
          session.reply.raw.write(`event: error\ndata: ${errorData}\n\n`);
        }

        return reply.code(202).send({ accepted: true });
      }
    }
  );

  // ==================== 聚合 Streamable HTTP 端点 ====================
  // POST /mcp — 聚合模式，自动路由到对应工具
  app.post(
    "/mcp",
    async (
      request: FastifyRequest,
      reply: FastifyReply
    ) => {
      const body = request.body as Record<string, unknown>;
      const method = body?.method as string | undefined;

      if (!method) {
        return reply.code(400).send({
          jsonrpc: "2.0",
          error: { code: -32600, message: "缺少 method 字段" },
          id: body?.id ?? null,
        });
      }

      try {
        const result = await handleAggregatedRequest(proxyManager, method, body);
        return reply.send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[aggregate] 请求失败:`, message);
        return reply.code(500).send({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: (body?.id as number | string | null) ?? null,
        });
      }
    }
  );

  // ==================== 单工具 SSE 端点 ====================
  // GET /mcp/:toolName/sse — 建立 SSE 连接
  app.get(
    "/mcp/:toolName/sse",
    async (
      request: FastifyRequest<{ Params: { toolName: string } }>,
      reply: FastifyReply
    ) => {
      const { toolName } = request.params;
      const proxy = proxyManager.getProxy(toolName);

      if (!proxy) {
        return reply.code(404).send({ error: `工具 "${toolName}" 未找到` });
      }

      if (proxy.proxyStatus !== "running") {
        return reply.code(503).send({
          error: `工具 "${toolName}" 当前不可用 (${proxy.proxyStatus})`,
        });
      }

      const sessionId = `${toolName}-${++sseSessionCounter}`;

      // 设置 SSE 响应头
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // 发送 endpoint 事件 — 告诉客户端 POST 消息的地址（完整 URL）
      const protocol = request.protocol || "http";
      const host = request.headers.host || request.hostname;
      const endpointUrl = `${protocol}://${host}/mcp/${toolName}/message?sessionId=${sessionId}`;
      reply.raw.write(`event: endpoint\ndata: ${endpointUrl}\n\n`);

      // 发送初始化的工具列表
      reply.raw.write(`event: tools_list\ndata: ${JSON.stringify(proxy.tools)}\n\n`);

      // 发送资源列表（如果有）
      if (proxy.resources.length > 0) {
        reply.raw.write(`event: resources_list\ndata: ${JSON.stringify(proxy.resources)}\n\n`);
      }

      // 发送提示词列表（如果有）
      if (proxy.prompts.length > 0) {
        reply.raw.write(`event: prompts_list\ndata: ${JSON.stringify(proxy.prompts)}\n\n`);
      }

      // 创建会话
      const session: SseSession = {
        id: sessionId,
        reply,
        messageQueue: [],
      };
      sseSessions.set(sessionId, session);

      // 保持连接 — 定期发送心跳
      const keepAlive = setInterval(() => {
        try {
          reply.raw.write(": keepalive\n\n");
        } catch {
          clearInterval(keepAlive);
        }
      }, 15000);

      // 客户端断开时清理
      request.raw.on("close", () => {
        clearInterval(keepAlive);
        sseSessions.delete(sessionId);
        // 拒绝所有待处理的消息
        for (const pending of session.messageQueue) {
          pending.reject(new Error("SSE 连接已关闭"));
        }
        session.messageQueue = [];
      });
    }
  );

  // ==================== 消息端点 ====================
  // POST /mcp/:toolName/message?sessionId=xxx — 接收客户端消息
  app.post(
    "/mcp/:toolName/message",
    async (
      request: FastifyRequest<{
        Params: { toolName: string };
        Querystring: { sessionId?: string };
      }>,
      reply: FastifyReply
    ) => {
      const { toolName } = request.params;
      const sessionId = request.query.sessionId;

      if (!sessionId || !sseSessions.has(sessionId)) {
        return reply.code(404).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: "SSE 会话未找到或已过期" },
          id: null,
        });
      }

      const proxy = proxyManager.getProxy(toolName);
      if (!proxy) {
        return reply.code(404).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: `工具 "${toolName}" 未找到` },
          id: null,
        });
      }

      if (proxy.proxyStatus !== "running") {
        return reply.code(503).send({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `工具 "${toolName}" 当前不可用 (${proxy.proxyStatus})`,
          },
          id: null,
        });
      }

      const body = request.body as Record<string, unknown>;
      const method = body?.method as string | undefined;

      if (!method) {
        return reply.code(400).send({
          jsonrpc: "2.0",
          error: { code: -32600, message: "缺少 method 字段" },
          id: body?.id ?? null,
        });
      }

      try {
        const result = await handleMcpRequest(proxy, method, body);

        // 通过 SSE 发送响应
        const session = sseSessions.get(sessionId)!;
        const data = JSON.stringify(result);
        session.reply.raw.write(`event: message\ndata: ${data}\n\n`);

        return reply.code(202).send({ accepted: true });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${toolName}] 请求失败:`, message);

        const session = sseSessions.get(sessionId);
        if (session) {
          const errorData = JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message },
            id: (body?.id as number | string | null) ?? null,
          });
          session.reply.raw.write(`event: error\ndata: ${errorData}\n\n`);
        }

        return reply.code(202).send({ accepted: true });
      }
    }
  );

  // ==================== Streamable HTTP 端点 ====================
  // POST /mcp/:toolName — 处理 MCP JSON-RPC 请求（单次请求-响应模式）
  app.post(
    "/mcp/:toolName",
    async (
      request: FastifyRequest<{ Params: { toolName: string } }>,
      reply: FastifyReply
    ) => {
      const { toolName } = request.params;
      const proxy = proxyManager.getProxy(toolName);

      if (!proxy) {
        return reply.code(404).send({
          jsonrpc: "2.0",
          error: { code: -32000, message: `工具 "${toolName}" 未找到` },
          id: null,
        });
      }

      if (proxy.proxyStatus !== "running") {
        return reply.code(503).send({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `工具 "${toolName}" 当前不可用 (${proxy.proxyStatus})`,
          },
          id: null,
        });
      }

      const body = request.body as Record<string, unknown>;
      const method = body?.method as string | undefined;

      if (!method) {
        return reply.code(400).send({
          jsonrpc: "2.0",
          error: { code: -32600, message: "缺少 method 字段" },
          id: body?.id ?? null,
        });
      }

      try {
        const result = await handleMcpRequest(proxy, method, body);
        return reply.send(result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[${toolName}] 请求失败:`, message);
        return reply.code(500).send({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: body?.id ?? null,
        });
      }
    }
  );
}

/** 处理 MCP JSON-RPC 请求 */
async function handleMcpRequest(
  proxy: import("../proxy/McpProxy.js").McpProxy,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const id = body?.id ?? null;

  switch (method) {
    // ===== 工具相关 =====
    case "tools/list": {
      return {
        jsonrpc: "2.0",
        result: { tools: proxy.tools },
        id,
      };
    }

    case "tools/call": {
      const toolName = params.name as string;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await proxy.callTool(toolName, args);
      return {
        jsonrpc: "2.0",
        result,
        id,
      };
    }

    // ===== 资源相关 =====
    case "resources/list": {
      const resources = await proxy.listResources();
      return {
        jsonrpc: "2.0",
        result: { resources },
        id,
      };
    }

    case "resources/read": {
      const uri = params.uri as string;
      const contents = await proxy.readResource(uri);
      return {
        jsonrpc: "2.0",
        result: { contents },
        id,
      };
    }

    // ===== 提示词相关 =====
    case "prompts/list": {
      const prompts = await proxy.listPrompts();
      return {
        jsonrpc: "2.0",
        result: { prompts },
        id,
      };
    }

    case "prompts/get": {
      const promptName = params.name as string;
      const promptArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await proxy.getPrompt(promptName, promptArgs);
      return {
        jsonrpc: "2.0",
        result,
        id,
      };
    }

    // ===== 初始化 =====
    case "initialize": {
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: `romate-mcp-gateway-${proxy.name}`,
            version: "0.1.0",
          },
        },
        id,
      };
    }

    case "notifications/initialized": {
      return { jsonrpc: "2.0", result: null, id };
    }

    // ===== 未知方法 =====
    default:
      return {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: `不支持的方法: ${method}`,
        },
        id,
      };
  }
}

/** 处理聚合模式的 MCP JSON-RPC 请求 */
async function handleAggregatedRequest(
  proxyManager: ProxyManager,
  method: string,
  body: Record<string, unknown>
): Promise<unknown> {
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const id = body?.id ?? null;

  switch (method) {
    // ===== 工具列表：聚合所有工具 =====
    case "tools/list": {
      const aggregatedTools = proxyManager.aggregateTools();
      return {
        jsonrpc: "2.0",
        result: { tools: aggregatedTools },
        id,
      };
    }

    // ===== 工具调用：根据 toolName 前缀路由到对应代理 =====
    case "tools/call": {
      const fullName = params.name as string;
      // 格式: proxyName_toolName，找到第一个下划线分割
      const underscoreIdx = fullName.indexOf("_");
      if (underscoreIdx === -1) {
        return {
          jsonrpc: "2.0",
          error: {
            code: -32602,
            message: `工具名 "${fullName}" 格式无效，应为 "proxyName_toolName"`,
          },
          id,
        };
      }
      const proxyName = fullName.substring(0, underscoreIdx);
      const toolName = fullName.substring(underscoreIdx + 1);
      const proxy = proxyManager.getProxy(proxyName);
      if (!proxy) {
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `代理 "${proxyName}" 未找到`,
          },
          id,
        };
      }
      if (proxy.proxyStatus !== "running") {
        return {
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: `代理 "${proxyName}" 当前不可用 (${proxy.proxyStatus})`,
          },
          id,
        };
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await proxy.callTool(toolName, args);
      return {
        jsonrpc: "2.0",
        result,
        id,
      };
    }

    // ===== 资源列表：聚合所有资源 =====
    case "resources/list": {
      const allProxies = proxyManager.getAllProxies();
      const allResources: Array<{ proxyName: string; uri: string; name?: string; description?: string }> = [];
      for (const [proxyName, proxy] of allProxies) {
        for (const r of proxy.resources) {
          allResources.push({ proxyName, ...r });
        }
      }
      return {
        jsonrpc: "2.0",
        result: { resources: allResources },
        id,
      };
    }

    // ===== 资源读取：通过 proxyName:uri 格式路由 =====
    case "resources/read": {
      const uri = params.uri as string;
      const colonIdx = uri.indexOf(":");
      if (colonIdx === -1) {
        return {
          jsonrpc: "2.0",
          error: {
            code: -32602,
            message: `资源 URI "${uri}" 格式无效，应为 "proxyName:resourceUri"`,
          },
          id,
        };
      }
      const proxyName = uri.substring(0, colonIdx);
      const resourceUri = uri.substring(colonIdx + 1);
      const proxy = proxyManager.getProxy(proxyName);
      if (!proxy) {
        return {
          jsonrpc: "2.0",
          error: { code: -32000, message: `代理 "${proxyName}" 未找到` },
          id,
        };
      }
      const contents = await proxy.readResource(resourceUri);
      return {
        jsonrpc: "2.0",
        result: { contents },
        id,
      };
    }

    // ===== 提示词列表：聚合所有提示词 =====
    case "prompts/list": {
      const allProxies = proxyManager.getAllProxies();
      const allPrompts: Array<{ proxyName: string; name: string; description?: string }> = [];
      for (const [proxyName, proxy] of allProxies) {
        for (const p of proxy.prompts) {
          allPrompts.push({ proxyName, ...p });
        }
      }
      return {
        jsonrpc: "2.0",
        result: { prompts: allPrompts },
        id,
      };
    }

    // ===== 提示词获取：通过 proxyName_name 格式路由 =====
    case "prompts/get": {
      const fullName = params.name as string;
      const underscoreIdx = fullName.indexOf("_");
      if (underscoreIdx === -1) {
        return {
          jsonrpc: "2.0",
          error: {
            code: -32602,
            message: `提示词名 "${fullName}" 格式无效，应为 "proxyName_promptName"`,
          },
          id,
        };
      }
      const proxyName = fullName.substring(0, underscoreIdx);
      const promptName = fullName.substring(underscoreIdx + 1);
      const proxy = proxyManager.getProxy(proxyName);
      if (!proxy) {
        return {
          jsonrpc: "2.0",
          error: { code: -32000, message: `代理 "${proxyName}" 未找到` },
          id,
        };
      }
      const promptArgs = (params.arguments ?? {}) as Record<string, unknown>;
      const result = await proxy.getPrompt(promptName, promptArgs);
      return {
        jsonrpc: "2.0",
        result,
        id,
      };
    }

    // ===== 初始化 =====
    case "initialize": {
      return {
        jsonrpc: "2.0",
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
            resources: {},
            prompts: {},
          },
          serverInfo: {
            name: "romate-mcp-gateway-aggregate",
            version: "0.1.0",
          },
        },
        id,
      };
    }

    case "notifications/initialized": {
      return { jsonrpc: "2.0", result: null, id };
    }

    // ===== 未知方法 =====
    default:
      return {
        jsonrpc: "2.0",
        error: {
          code: -32601,
          message: `不支持的方法: ${method}`,
        },
        id,
      };
  }
}