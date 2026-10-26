import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  ListToolsResultSchema,
  ListResourcesResultSchema,
  ListPromptsResultSchema,
  CallToolResultSchema,
  ReadResourceResultSchema,
  GetPromptResultSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Tool,
  CallToolResult,
  ListResourcesResult,
  ReadResourceResult,
  ListPromptsResult,
  GetPromptResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ToolConfig } from "../config/schema.js";

/** 代理状态 */
export type ProxyStatus = "starting" | "running" | "stopped" | "error";

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} 超时 (${ms}ms)`)), ms)
    ),
  ]);
}

/** 默认超时时间 */
const DEFAULT_HANDSHAKE_TIMEOUT = 10_000;  // 握手超时 10s（可被 config.handshakeTimeout 覆盖）
const DEFAULT_TOOL_CALL_TIMEOUT = 60_000;  // 工具调用超时 60s

/**
 * McpProxy — 管理一个本地 stdio MCP 子进程，
 * 提供 JSON-RPC 调用代理能力。
 */
export class McpProxy {
  private config: ToolConfig;
  private transport: StdioClientTransport | null = null;
  private client: Client | null = null;
  private status: ProxyStatus = "stopped";
  private toolsCache: Tool[] = [];
  private resourcesCache: ListResourcesResult["resources"] = [];
  private promptsCache: ListPromptsResult["prompts"] = [];
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdownRequested = false;
  private restartAttempts = 0;
  private maxRestartDelay = 30_000; // 最大退避延迟 30s

  constructor(config: ToolConfig) {
    this.config = config;
  }

  get name(): string {
    return this.config.name;
  }

  get description(): string {
    return this.config.description;
  }

  /** 当前生效的配置，供热重载比对是否变化 */
  get settings(): ToolConfig {
    return this.config;
  }

  get proxyStatus(): ProxyStatus {
    return this.status;
  }

  get tools(): Tool[] {
    return this.toolsCache;
  }

  get resources(): ListResourcesResult["resources"] {
    return this.resourcesCache;
  }

  get prompts(): ListPromptsResult["prompts"] {
    return this.promptsCache;
  }

  /** 启动子进程并完成 MCP 握手 */
  async start(): Promise<void> {
    if (this.status === "running") return;
    this.shutdownRequested = false;
    this.status = "starting";

    try {
      await withTimeout(this.spawnProcess(), this.config.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT, `[${this.name}] 握手`);
      await this.performHandshake();
      this.status = "running";
      this.restartAttempts = 0; // 启动成功后重置退避计数
      console.log(`[${this.name}] 启动成功，工具数: ${this.toolsCache.length}`);
    } catch (err) {
      this.status = "error";
      console.error(`[${this.name}] 启动失败:`, err);
      // 清理可能部分启动的资源
      try { await this.cleanup(); } catch { /* ignore */ }
      throw err;
    }
  }

  /** 停止子进程 */
  async stop(): Promise<void> {
    this.shutdownRequested = true;
    this.cancelRestart();
    await this.cleanup();
    this.status = "stopped";
    console.log(`[${this.name}] 已停止`);
  }

  /** 清理资源（不修改状态标志） */
  private async cleanup(): Promise<void> {
    try {
      if (this.client) {
        await withTimeout(this.client.close(), 5_000, `[${this.name}] 关闭`);
      }
    } catch (err) {
      console.warn(`[${this.name}] 关闭时出错:`, err);
    }

    this.transport = null;
    this.client = null;
    this.toolsCache = [];
    this.resourcesCache = [];
    this.promptsCache = [];
  }

  private cancelRestart(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /** 调用工具 */
  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.ensureRunning();
    return withTimeout(
      this.client!.request(
        {
          method: "tools/call",
          params: { name, arguments: args },
        },
        CallToolResultSchema
      ),
      DEFAULT_TOOL_CALL_TIMEOUT,
      `[${this.name}] tools/call "${name}"`
    );
  }

  /** 列出资源 */
  async listResources(): Promise<ListResourcesResult["resources"]> {
    this.ensureRunning();
    const result = await this.client!.request(
      { method: "resources/list", params: {} },
      ListResourcesResultSchema
    );
    this.resourcesCache = result.resources ?? [];
    return this.resourcesCache;
  }

  /** 读取资源 */
  async readResource(uri: string): Promise<ReadResourceResult["contents"]> {
    this.ensureRunning();
    const result = await this.client!.request(
      { method: "resources/read", params: { uri } },
      ReadResourceResultSchema
    );
    return result.contents;
  }

  /** 列出提示词 */
  async listPrompts(): Promise<ListPromptsResult["prompts"]> {
    this.ensureRunning();
    const result = await this.client!.request(
      { method: "prompts/list", params: {} },
      ListPromptsResultSchema
    );
    this.promptsCache = result.prompts ?? [];
    return this.promptsCache;
  }

  /** 获取提示词 */
  async getPrompt(name: string, args: Record<string, unknown>): Promise<GetPromptResult> {
    this.ensureRunning();
    return this.client!.request(
      { method: "prompts/get", params: { name, arguments: args } },
      GetPromptResultSchema
    );
  }

  // ==================== 私有方法 ====================

  private async spawnProcess(): Promise<void> {
    const { command, args, env, cwd } = this.config;

    const mergedEnv = {
      ...env,
    };

    this.transport = new StdioClientTransport({
      command,
      args,
      env: Object.keys(mergedEnv).length > 0 ? mergedEnv : undefined,
      cwd,
      stderr: "pipe",
    });

    // 捕获子进程 stderr，方便诊断启动失败原因
    const stderrStream = (this.transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr;
    if (stderrStream) {
      stderrStream.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trimEnd();
        if (line) console.log(`[${this.name}] stderr: ${line}`);
      });
    }

    // 监听 transport 错误
    this.transport.onerror = (err) => {
      console.error(`[${this.name}] transport 错误:`, err);
    };

    this.transport.onclose = () => {
      console.log(`[${this.name}] transport 已关闭`);
      this.transport = null;
      this.client = null;

      if (!this.shutdownRequested && this.config.restart) {
        this.scheduleRestart();
      }
    };

    this.client = new Client(
      {
        name: "romate-mcp-gateway",
        version: "0.1.0",
      },
      {
        capabilities: {},
      }
    );

    // StdioClientTransport.start() 会 spawn 子进程
    // 但我们需要先 connect，start 会在 connect 中被调用
    // SDK 默认 initialize 超时为 60s，这里同步改为握手超时，否则慢启动的服务会先被 SDK 超时
    await this.client.connect(this.transport, {
      timeout: this.config.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT,
    });
  }

  private async performHandshake(): Promise<void> {
    // connect 已经完成了 initialize 握手
    // 现在获取初始能力列表
    const client = this.client!;
    try {
      const toolsResult = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema
      );
      this.toolsCache = toolsResult.tools ?? [];
    } catch {
      this.toolsCache = [];
    }

    try {
      const resourcesResult = await client.request(
        { method: "resources/list", params: {} },
        ListResourcesResultSchema
      );
      this.resourcesCache = resourcesResult.resources ?? [];
    } catch {
      this.resourcesCache = [];
    }

    try {
      const promptsResult = await client.request(
        { method: "prompts/list", params: {} },
        ListPromptsResultSchema
      );
      this.promptsCache = promptsResult.prompts ?? [];
    } catch {
      this.promptsCache = [];
    }
  }

  private scheduleRestart(): void {
    // 避免 close 事件和启动失败回调重复排程，只保留一个定时器
    this.cancelRestart();
    this.restartAttempts++;
    const baseDelay = this.config.restartDelay ?? 2000;
    // 指数退避：baseDelay * 2^(attempts-1)，上限 maxRestartDelay
    const delay = Math.min(
      baseDelay * Math.pow(2, this.restartAttempts - 1),
      this.maxRestartDelay
    );
    console.log(`[${this.name}] ${delay}ms 后自动重启 (第 ${this.restartAttempts} 次尝试)...`);
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.start();
      } catch (err) {
        console.error(`[${this.name}] 重启失败:`, err);
        // 启动失败后继续排程下一次重试，直到成功或被 stop() 取消
        if (!this.shutdownRequested) this.scheduleRestart();
      }
    }, delay);
  }

  private ensureRunning(): void {
    if (this.status !== "running" || !this.client) {
      throw new Error(`工具 ${this.name} 当前不可用 (status: ${this.status})`);
    }
  }
}