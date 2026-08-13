# 🚀 mcp-proxy-server

**HTTP MCP Gateway** — 将本地 stdio MCP 工具暴露为 HTTP/SSE 协议。

> 你只需要配置本地执行的命令，romate-mcp-server 就会自动将任意 stdio MCP 服务器注册为 HTTP 端点，让远程客户端（如 Claude Desktop、Cline 等）通过网络调用。

---

## 特性

| 特性 | 说明 |
|------|------|
| 🔌 **零代码集成** | 只需 YAML 配置命令，无需修改任何 MCP 服务器代码 |
| 🌐 **HTTP + SSE 双协议** | 支持 Streamable HTTP 和 Server-Sent Events 两种传输方式 |
| 🔗 **聚合模式** | 单一路径聚合所有工具，自动 `proxyName_toolName` 前缀路由 |
| 🔐 **Bearer Token 鉴权** | 可选 Token 鉴权，支持排除路径 |
| ♻️ **自动重启** | 子进程崩溃后自动重启，指数退避策略 |
| ⏱️ **超时控制** | 握手超时 10s，工具调用超时 60s |
| 🔄 **配置热重载** | 监听配置文件变更，自动增删改代理实例 |
| 🩺 **健康检查** | `/health` 和 `/tools` 端点，实时监控状态 |

---

## 快速开始

### 安装

```bash
git clone <your-repo> && cd romate-mcp-server
npm install
npm run build
```

### 配置

创建 `config.yaml`：

```yaml
server:
  port: 3100
  host: "0.0.0.0"
  auth:
    token: "your-secret-token"      # 可选，Bearer Token 鉴权
    excludePaths:
      - "/health"                    # 无需鉴权的路径

tools:
  - name: "filesystem"
    description: "文件系统操作工具"
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-filesystem"
      - "/tmp"
    restart: true
    restartDelay: 2000

  - name: "github"
    description: "GitHub API 工具"
    command: "npx"
    args:
      - "-y"
      - "@modelcontextprotocol/server-github"
    env:
      GITHUB_TOKEN: "${GITHUB_TOKEN}"   # 支持环境变量插值
```

### 启动

```bash
# 开发模式（热重载）
npm run dev -- ./config.yaml

# 生产模式
npm run build
node dist/index.js ./config.yaml
```

---

## 路由总览

| 路径 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（无需鉴权） |
| `/tools` | GET | 列出所有已注册工具 |
| `/mcp/:toolName` | POST | 单工具 Streamable HTTP |
| `/mcp/:toolName/sse` | GET | 单工具 SSE 端点 |
| `/mcp/:toolName/message?sessionId=` | POST | 单工具 SSE 消息 |
| `/mcp` | POST | **聚合模式** — 所有工具统一入口 |
| `/mcp/sse` | GET | **聚合模式** SSE 端点 |
| `/mcp/message?sessionId=` | POST | **聚合模式** SSE 消息 |

---

## 使用示例

### 单工具模式

```bash
# 列出工具
curl -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3100/mcp/filesystem \
  -d '{"method":"tools/list","id":1}'

# 调用工具
curl -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3100/mcp/filesystem \
  -d '{
    "method": "tools/call",
    "params": {
      "name": "read_file",
      "arguments": { "path": "/tmp/test.txt" }
    },
    "id": 2
  }'
```

### 聚合模式

聚合模式下，工具名自动添加 `{proxyName}_` 前缀以避免冲突：

```bash
# 列出所有工具（返回 echo_echo, filesystem_read_file, github_search_repos 等）
curl -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3100/mcp \
  -d '{"method":"tools/list","id":1}'

# 调用工具 — 使用 proxyName_toolName 格式
curl -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -X POST http://localhost:3100/mcp \
  -d '{
    "method": "tools/call",
    "params": {
      "name": "filesystem_read_file",
      "arguments": { "path": "/tmp/test.txt" }
    },
    "id": 2
  }'
```

### SSE 模式（适用于 Claude Desktop 等客户端）

```
# 1. 客户端建立 SSE 连接
GET /mcp/filesystem/sse
→ event: endpoint
→ data: http://localhost:3100/mcp/filesystem/message?sessionId=filesystem-1
→ event: tools_list
→ data: [...]

# 2. 客户端向 endpoint URL 发送 JSON-RPC 请求
POST http://localhost:3100/mcp/filesystem/message?sessionId=filesystem-1
Content-Type: application/json

{"method":"tools/list","id":1}

# 3. 响应通过 SSE 连接返回
→ event: message
→ data: {"jsonrpc":"2.0","result":{"tools":[...]},"id":1}
```

---

## MCP 客户端配置

romate-mcp-server 兼容所有支持 HTTP/SSE 传输的 MCP 客户端。以下是一些常见客户端的配置方式：

### Claude Desktop

在 `claude_desktop_config.json` 中添加 MCP 服务器配置：

```json
{
  "mcpServers": {
    "romate-filesystem": {
      "type": "sse",
      "url": "http://your-server:3100/mcp/filesystem/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    },
    "romate-github": {
      "type": "sse",
      "url": "http://your-server:3100/mcp/github/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

### Cline / Roo Code / Claude Dev

在 MCP 配置文件（通常为 `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/cline_mcp_settings.json` 或类似路径）中添加：

```json
{
  "mcpServers": {
    "romate-filesystem": {
      "type": "sse",
      "url": "http://your-server:3100/mcp/filesystem/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

### 聚合模式客户端配置

如果希望在一个 SSE 连接中访问所有工具，使用聚合端点：

```json
{
  "mcpServers": {
    "romate-all-tools": {
      "type": "sse",
      "url": "http://your-server:3100/mcp/sse",
      "headers": {
        "Authorization": "Bearer your-secret-token"
      }
    }
  }
}
```

> **注意**：聚合模式下工具名会带有 `{proxyName}_` 前缀，例如 `filesystem_read_file`、`github_search_repos`。

### 自定义客户端（Streamable HTTP）

支持 MCP Streamable HTTP 传输的客户端可以直接使用 POST 端点：

```
POST http://your-server:3100/mcp/filesystem
Content-Type: application/json
Authorization: Bearer your-secret-token

{"method":"tools/list","id":1}
```

---

## 配置参考

### `server` 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `port` | number | `3100` | HTTP 监听端口 |
| `host` | string | `"0.0.0.0"` | 监听地址 |
| `auth.token` | string | — | Bearer Token，不配置则不启用鉴权 |
| `auth.excludePaths` | string[] | `["/health"]` | 无需鉴权的路径前缀 |

### `tools[]` 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `name` | string | — | **必填**。工具唯一标识名 |
| `description` | string | `""` | 工具描述 |
| `command` | string | — | **必填**。启动命令 |
| `args` | string[] | `[]` | 命令参数 |
| `env` | object | `{}` | 环境变量，支持 `${VAR_NAME}` 插值 |
| `cwd` | string | — | 工作目录 |
| `restart` | boolean | `true` | 崩溃后是否自动重启 |
| `restartDelay` | number | `2000` | 重启基础延迟(ms)，指数退避 x2，上限 30s |

---

## 架构

```
┌─────────────────────────────────────────────────┐
│                  HTTP Client                     │
│        (Claude Desktop, Cline, curl, etc.)       │
└──────────────────┬──────────────────────────────┘
                   │ HTTP/SSE
                   ▼
┌─────────────────────────────────────────────────┐
│              romate-mcp-server                   │
│                                                   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Auth    │  │  Routes  │  │  Health  │       │
│  │ Middleware│  │  /mcp/*  │  │  /health │       │
│  └──────────┘  └────┬─────┘  └──────────┘       │
│                     │                             │
│  ┌──────────────────▼──────────────────────────┐ │
│  │            ProxyManager                      │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐   │ │
│  │  │ McpProxy │  │ McpProxy │  │ McpProxy │   │ │
│  │  │ (echo)   │  │(fs)      │  │(github)  │   │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘   │ │
│  └───────┼──────────────┼──────────────┼────────┘ │
└──────────┼──────────────┼──────────────┼──────────┘
           │              │              │
           ▼              ▼              ▼
     ┌──────────┐  ┌──────────┐  ┌──────────┐
     │  stdio   │  │  stdio   │  │  stdio   │
     │ MCP 进程 │  │ MCP 进程 │  │ MCP 进程 │
     └──────────┘  └──────────┘  └──────────┘
```

### 工作流程

1. **启动** → 加载 YAML 配置 → 为每个工具创建 `McpProxy` 实例
2. **连接** → 每个 `McpProxy` 通过 `StdioClientTransport` 启动子进程 → 完成 MCP 握手 → 缓存 tools/resources/prompts
3. **代理** → HTTP 请求到达 → 鉴权 → 路由到对应 `McpProxy` → JSON-RPC 调用转发到子进程 → 返回结果
4. **容错** → 子进程崩溃 → `onclose` 触发 → 指数退避自动重启（`restart: true` 时）
5. **热重载** → 配置文件变更 → 对比新旧配置 → 自动增/删/改代理实例

---

## 开发

```bash
# 类型检查
npm run typecheck

# 开发模式（tsx watch 自动重启）
npm run dev -- ./config.yaml

# 构建
npm run build

# 生产启动
npm start -- ./config.yaml
```

---

## 许可证

MIT
