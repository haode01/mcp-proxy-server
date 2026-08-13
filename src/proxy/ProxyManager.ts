import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpProxy, type ProxyStatus } from "./McpProxy.js";
import type { ToolConfig } from "../config/schema.js";

export interface ProxyInfo {
  name: string;
  description: string;
  status: ProxyStatus;
  tools: Tool[];
}

/**
 * ProxyManager — 管理所有 McpProxy 实例的生命周期。
 */
export class ProxyManager {
  private proxies = new Map<string, McpProxy>();

  /** 根据配置初始化所有代理 */
  async initialize(configs: ToolConfig[]): Promise<void> {
    const results = await Promise.allSettled(
      configs.map(async (cfg) => {
        const proxy = new McpProxy(cfg);
        await proxy.start();
        this.proxies.set(cfg.name, proxy);
      })
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    console.log(
      `代理初始化完成: 成功=${succeeded}, 失败=${failed}, 总计=${configs.length}`
    );

    // 打印失败详情
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`  [${configs[i].name}] 初始化失败:`, r.reason);
      }
    });
  }

  /** 获取指定代理 */
  getProxy(name: string): McpProxy | undefined {
    return this.proxies.get(name);
  }

  /** 获取所有代理信息 */
  getAllProxies(): Map<string, McpProxy> {
    return new Map(this.proxies);
  }

  /** 获取所有代理的摘要信息 */
  getProxyInfos(): ProxyInfo[] {
    const infos: ProxyInfo[] = [];
    for (const proxy of this.proxies.values()) {
      infos.push({
        name: proxy.name,
        description: proxy.description,
        status: proxy.proxyStatus,
        tools: proxy.tools,
      });
    }
    return infos;
  }

  /** 聚合所有工具 */
  aggregateTools(): Tool[] {
    const all: Tool[] = [];
    for (const proxy of this.proxies.values()) {
      for (const tool of proxy.tools) {
        all.push({
          ...tool,
          name: `${proxy.name}_${tool.name}`,
        });
      }
    }
    return all;
  }

  /** 优雅关闭所有代理 */
  async shutdown(): Promise<void> {
    console.log("正在关闭所有代理...");
    const results = await Promise.allSettled(
      Array.from(this.proxies.values()).map((p) =>
        Promise.race([
          p.stop(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error(`关闭超时`)), 8_000)
          ),
        ])
      )
    );

    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.filter((r) => r.status === "rejected").length;

    if (failed > 0) {
      console.error(`${failed}/${results.length} 个代理关闭失败`);
    } else {
      console.log(`所有代理已关闭 (${succeeded}/${results.length})`);
    }

    this.proxies.clear();
  }

  /**
   * 热重载 — 对比新旧配置，增/删/改对应的代理
   * @returns 变更摘要 { added, removed, updated, errors }
   */
  async reload(configs: ToolConfig[]): Promise<{
    added: string[];
    removed: string[];
    updated: string[];
    errors: string[];
  }> {
    const result: { added: string[]; removed: string[]; updated: string[]; errors: string[] } = {
      added: [],
      removed: [],
      updated: [],
      errors: [],
    };

    const newNames = new Set(configs.map((c) => c.name));
    const oldNames = new Set(this.proxies.keys());

    // 1. 移除不再存在的代理
    for (const name of oldNames) {
      if (!newNames.has(name)) {
        try {
          const proxy = this.proxies.get(name)!;
          await proxy.stop();
          this.proxies.delete(name);
          result.removed.push(name);
          console.log(`[hot-reload] 已移除代理: ${name}`);
        } catch (err) {
          result.errors.push(`移除 ${name} 失败: ${err}`);
          console.error(`[hot-reload] 移除 ${name} 失败:`, err);
        }
      }
    }

    // 2. 新增或更新代理
    for (const cfg of configs) {
      if (!oldNames.has(cfg.name)) {
        // 新增
        try {
          const proxy = new McpProxy(cfg);
          await proxy.start();
          this.proxies.set(cfg.name, proxy);
          result.added.push(cfg.name);
          console.log(`[hot-reload] 已新增代理: ${cfg.name}`);
        } catch (err) {
          result.errors.push(`新增 ${cfg.name} 失败: ${err}`);
          console.error(`[hot-reload] 新增 ${cfg.name} 失败:`, err);
        }
      } else {
        // 更新 — 先停旧再启新
        try {
          const oldProxy = this.proxies.get(cfg.name)!;
          await oldProxy.stop();
          const proxy = new McpProxy(cfg);
          await proxy.start();
          this.proxies.set(cfg.name, proxy);
          result.updated.push(cfg.name);
          console.log(`[hot-reload] 已更新代理: ${cfg.name}`);
        } catch (err) {
          result.errors.push(`更新 ${cfg.name} 失败: ${err}`);
          console.error(`[hot-reload] 更新 ${cfg.name} 失败:`, err);
        }
      }
    }

    return result;
  }
}