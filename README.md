<div align="center">

# Open-WebSearch


</div>

`open-websearch` 提供 MCP 服务器、命令行工具（CLI）和本地守护进程，也可配合技能引导的智能体工作流，无需 API 密钥即可进行实时网页搜索和内容获取。

支持 Windows 和 Linux，使用 Node.js 22 LTS，最低版本为 22.23.3。项目通过 .nvmrc 指定 Node.js 22.23.3，Docker 使用 Node.js 22 Alpine。macOS 不再受支持。

## 功能特点

- 支持多引擎网页搜索
    - Bing
    - 百度
    - ~~linux.do~~（暂不支持）
    - CSDN
    - DuckDuckGo
    - Exa
    - Brave
    - 掘金
    - Startpage
    - 搜狗
    - Hacker News
- 支持配置 HTTP 代理，访问受限资源
- 无需 API 密钥或身份验证
- 返回包含标题、URL 和描述的结构化结果
- 可配置每次搜索返回的结果数量
- 可自定义默认搜索引擎
- 支持获取单篇文章的内容
    - CSDN
    - GitHub（README 文件）
    - 通用 HTTP(S) 网页或 Markdown 内容

## 选择合适的使用方式

- `MCP`
  - 适合将 `open-websearch` 接入 Claude Desktop、Cherry Studio、Cursor 或其他 MCP 客户端。
- `CLI`
  - 适合执行一次性本地命令、编写脚本或直接在终端中使用。
- 本地守护进程
  - 适合需要重复调用、长期运行的本地 HTTP 服务，提供 `status`、`GET /health` 以及 `POST /search` / `POST /fetch-*`。使用 `open-websearch serve` 显式启动，并通过 `open-websearch status` 检查状态。
- 技能
  - 适合作为面向智能体的安装与使用指引。技能不替代 MCP、CLI 或本地守护进程；通常与 CLI 或本地守护进程配合，帮助智能体发现、启用并使用所需的最简可用方式。

## 配合技能使用

先为智能体安装 `open-websearch` 技能：

```bash
npx skills add https://github.com/Aas-ee/open-webSearch --skill open-websearch
```

首次使用时，技能通常会先检查是否已有可用的 `open-websearch` 接入方式；如果没有，则引导安装和启用；确认功能已激活后，再通过最简可用方式执行搜索或内容获取。

如果当前环境无法自动完成安装或启用，可以明确要求智能体先启动本地守护进程：

```bash
open-websearch serve
open-websearch status
```

安装时的代理设置与运行时的代理设置需要分别配置：

- 安装代理或镜像
  - 用于技能或智能体安装 `open-websearch`、`playwright` 或其他 npm 包时。
  - 在受限网络中，npm 专用参数或 npm 配置通常比通用的终端代理环境变量更有效，例如：

```bash
npm --proxy http://127.0.0.1:7890 --https-proxy http://127.0.0.1:7890 install -g open-websearch
```

- 运行时代理
  - 用于已安装的守护进程即将执行实时 `search` / `fetch` 操作时。
  - 影响 `serve` 启动后的 `open-websearch` 网络流量，例如：

```bash
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 open-websearch serve
```

如果智能体需要通过 npm 代理完成包安装，而启动后的实时搜索或内容获取也需要代理，应分别完成这两个配置步骤。

## 命令行工具与本地守护进程

CLI 用于一次性执行。本地守护进程是长期运行的本地 HTTP 服务，便于重复调用，减少反复启动的开销。使用 `open-websearch serve` 显式启动守护进程，使用 `open-websearch status` 显式检查其状态。

`search`、`fetch-web` 等操作命令会优先尝试可用的默认本地守护进程。如果传入 `--daemon-url`，则明确指定该守护进程，无法连接时不会静默回退到直接执行。

先构建项目：

```bash
npm run build
```

启动本地守护进程：

```bash
npm run serve
# 全局安装后使用：open-websearch serve
```

检查状态：

```bash
npm run status -- --json
# 全局安装后使用：open-websearch status --json
```

通过本地 CLI 执行一次搜索：

```bash
npm run search:cli -- "开放网页搜索" --json
```

注意：

- 直接运行 `open-websearch` 是兼容 MCP 服务器的启动入口。智能体自动化应使用 `open-websearch serve` 启动守护进程。
- 提取内容时，建议先搜索，再获取具体的结果页面。部分首页或大量依赖 JavaScript 的落地页可能无法通过 `fetch-web` 返回可读的文章正文。

本地守护进程 HTTP API（`serve`、`status`、`GET /health`、`POST /search`、`POST /fetch-*`）详见 [HTTP API 文档](docs/http-api.md)。

## 待办事项

- 支持 ~~Bing~~（已支持）、~~DuckDuckGo~~（已支持）、~~Exa~~（已支持）、~~Brave~~（已支持）、~~搜狗~~（已支持）、~~Hacker News~~（已支持）、Google 及其他搜索引擎
- 支持更多博客、论坛和社交平台
- 优化文章内容提取，支持更多网站
- ~~支持获取 GitHub README~~（已支持）

## 安装指南

如果将 `open-websearch` 用作 MCP 服务器，请继续按照下方的 MCP 配置步骤操作。

### 监听端口与本机访问

MCP 服务支持启动参数 `--port` 和 `--local-only`：

```bash
# MCP HTTP 使用 8080 端口，仅接受本机 IPv4 连接
node build/index.js --port 8080 --local-only
# 全局安装或 npm start
open-websearch --port 8080 --local-only
npm start -- --port 8080 --local-only

# 本地守护进程也支持；其默认端口仍为 3210
node build/index.js serve --port 3211 --local-only
```

`--port` 优先于 MCP 的 `PORT` 环境变量，范围为 1–65535，缺省为 3000。`--local-only` 将监听地址设为 `127.0.0.1`；也可设置 `LOCAL_ONLY=true`。MCP 缺省仍监听 `0.0.0.0`，以兼容远程客户端和容器端口映射。本地守护进程缺省监听 `127.0.0.1`，显式 `--local-only` 会覆盖其 `--host` 或 `OPEN_WEBSEARCH_DAEMON_HOST`。仅监听本机限制连接范围，HTTP 服务仍不提供调用者认证。

Docker 中的 `127.0.0.1` 指容器自身；通过宿主机端口映射访问容器时，应保留容器内默认监听方式。

### 默认资源限制

阈值集中在 `src/utils/resourceLimits.ts`，MCP、CLI 与守护进程共用：

| 项目 | 默认限制 | 超限行为 |
| --- | --- | --- |
| HTTP 请求超时 | 15 秒 | 取消请求；手动重定向链与 DNS 预检共用该预算 |
| HTTP 响应体 / 请求体 | 2 MiB | Axios 拒绝超限传输；专用文章与 README 抓取同样适用 |
| 单次搜索 | 最多 3 个不同引擎，原始数组最多 16 项 | 去重后执行，零结果预算不调用引擎，超限拒绝 |
| 搜索词 | 2048 字符 | 超限拒绝 |
| 同时搜索 | 每个运行时 4 个 | 立即返回资源限制错误，不排队 |
| 同时抓取 | 每个进程 4 个，各抓取工具共用 | 立即返回资源限制错误，不排队 |
| MCP 会话 | HTTP/SSE 共用 4 个，空闲 3 分钟回收 | 初始化超限返回 HTTP 429，关闭会话立即释放名额 |
| 浏览器池页面 | 每个浏览器最多 4 个物理页，不同 poolKey 共用 | 优先复用；用尽时返回资源限制错误 |
| Cookie 缓存 | 64 项，5 分钟 TTL | 访问时清理过期项，满时淘汰最久未使用项 |

调用方可配置更短的 HTTP 超时或更小的传输上限，不能放宽以上预算。通用网页抓取与单次浏览器任务的整体期限为 15 秒，清理最多另等待 3 秒；多引擎搜索或多次重试的整体工具调用仍可能超过 15 秒。搜索或抓取并发超限时，守护进程返回 HTTP 429、`resource_limit` 和 `Retry-After`；MCP 工具返回错误结果。

### NPX 快速开始（推荐）

最快的上手方式：

```bash
# 基本用法
npx open-websearch@latest

# 设置环境变量（Linux）
DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true npx open-websearch@latest

# Windows PowerShell
$env:DEFAULT_SEARCH_ENGINE="duckduckgo"; $env:ENABLE_CORS="true"; npx open-websearch@latest

# Windows CMD
set MODE=stdio && set DEFAULT_SEARCH_ENGINE=duckduckgo && npx open-websearch@latest

# 跨平台方式（需要 cross-env，用于本地开发）
npm install -g open-websearch
npx cross-env DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true open-websearch
```

**环境变量：**

| 变量 | 默认值 | 可选值 | 说明 |
|------|--------|--------|------|
| `ENABLE_CORS` | `false` | `true`、`false` | 启用跨域资源共享（CORS） |
| `CORS_ORIGIN` | `*` | 任意有效来源 | 配置 CORS 允许的来源 |
| `DEFAULT_SEARCH_ENGINE` | `bing` | `bing`、`duckduckgo`、`exa`、`brave`、`baidu`、`csdn`、`linuxdo`、`juejin`、`startpage`、`sogou`、`hackernews` | 默认搜索引擎 |
| `USE_PROXY` | `false` | `true`、`false` | 启用 HTTP 代理 |
| `PROXY_URL` | `http://127.0.0.1:7890` | 任意有效 URL | 代理服务器地址 |
| `FAKE_IP_CIDRS` | 空 | 以逗号分隔的 CIDR 列表 | 将这些网段内的 DNS 返回地址视为合成的虚拟 IP，不因其属于私有网络而阻止访问。直接使用私有或本地目标地址，以及其他私有网络 DNS 返回地址，仍会被阻止 |
| `FETCH_WEB_INSECURE_TLS` | `false` | `true`、`false` | 仅对 `fetchWebContent` 的请求阶段禁用 TLS 验证，不影响 Playwright 浏览器导航。仅用于证书链异常的情况 |
| `MODE` | `both` | `both`、`http`、`stdio` | 服务器模式：同时使用 HTTP 和 STDIO、仅 HTTP 或仅 STDIO |
| `PORT` | `3000` | 1–65535 | MCP HTTP 服务器端口，可被 `--port` 覆盖 |
| `LOCAL_ONLY` | `false` | `true`、`false` | 设为 `true` 时 MCP 与守护进程仅监听 `127.0.0.1`；也可用 `--local-only` 启用 |
| `ALLOWED_SEARCH_ENGINES` | 空（所有可用引擎） | 以逗号分隔的引擎名称 | 限制可使用的搜索引擎；若默认引擎不在列表中，则使用第一个允许的引擎作为默认值 |
| `SEARCH_MODE` | `auto` | `request`、`auto`、`playwright` | 搜索策略，目前仅影响 Bing：强制 HTTP 请求模式（`request`）、强制 Playwright 模式（`playwright`），或允许智能体选择（`auto`，默认）。强制模式不会向智能体提供 `searchMode` 覆盖参数。在 `auto` 模式下，服务器会检查 Playwright 是否确实可用（客户端模块能实际加载；本地启动时还需存在浏览器程序，可以是 `PLAYWRIGHT_EXECUTABLE_PATH` 指定的程序、随包安装的浏览器或系统 Chrome/Edge）。如果可用，搜索工具会提供 `searchMode` 参数，并引导智能体保留默认的 `auto`，仅在请求失败、结果为空或疑似被拦截时使用 `playwright` 重试；否则按强制请求模式运行。若强制使用 `playwright` 但其不可用，搜索会返回 `browser_unavailable` 错误 |
| `PLAYWRIGHT_PACKAGE` | `auto` | `auto`、`playwright`、`playwright-core` | 启用浏览器模式时要加载的 Playwright 客户端包 |
| `PLAYWRIGHT_MODULE_PATH` | 空 | 绝对路径或项目相对路径 | 复用本项目之外已有的 Playwright 客户端包 |
| `PLAYWRIGHT_EXECUTABLE_PATH` | 空 | 任意有效的浏览器程序路径 | 启动已有的 Chromium/Chrome，无需安装随包提供的浏览器 |
| `PLAYWRIGHT_WS_ENDPOINT` | 空 | 有效的 Playwright `ws://` / `wss://` 端点 | 连接已有的远程 Playwright 浏览器服务器 |
| `PLAYWRIGHT_CDP_ENDPOINT` | 空 | 有效的 Chromium CDP 端点 | 通过 CDP 连接已有的 Chromium 实例 |
| `PLAYWRIGHT_HEADLESS` | `true` | `true`、`false` | 是否以无头模式运行 Playwright Chromium |
| `PLAYWRIGHT_NAVIGATION_TIMEOUT_MS` | `15000` | 1–15000 | Playwright 页面导航和等待 Bing 搜索结果的单阶段超时（毫秒），更大值会限制为 15000 |
| `BROWSER_EGRESS_PROXY_URL` | 空 | 受控 HTTP 代理 origin | 浏览器实际出口代理；解析并校验全部目的地址后按具体 IP 建连 |
| `BROWSER_EGRESS_ENFORCED` | `false` | `true`、`false` | 浏览器所在网络已强制禁止绕过代理时设置为 true；缺少声明时浏览器任务拒绝启动 |
| `BROWSER_ALLOWED_PORTS` | `80,443` | 逗号分隔的 TCP 端口 | 应用、代理及网络策略一致的目标端口范围 |
| `OPEN_WEBSEARCH_PROFILE_DIR` | `<tmpdir>/open-websearch-browser-profiles` | 任意可写目录 | 本地浏览器持久化配置的根目录，详见下方浏览器状态说明 |
| `MCP_TOOL_SEARCH_NAME` | `search` | 有效的 MCP 工具名称 | 自定义搜索工具名称；设为 `<disabled>` 可禁用工具（bash/zsh 中写为 `'<disabled>'`，Windows cmd 中写为 `"<disabled>"`）。名称无效时会回退到默认值并发出警告 |
| `MCP_TOOL_FETCH_LINUXDO_NAME` | `fetchLinuxDoArticle` | 有效的 MCP 工具名称 | 自定义 Linux.do 文章获取工具名称；设为 `<disabled>` 可禁用工具（bash/zsh 中写为 `'<disabled>'`，Windows cmd 中写为 `"<disabled>"`）。名称无效时会回退到默认值并发出警告 |
| `MCP_TOOL_FETCH_CSDN_NAME` | `fetchCsdnArticle` | 有效的 MCP 工具名称 | 自定义 CSDN 文章获取工具名称；设为 `<disabled>` 可禁用工具（bash/zsh 中写为 `'<disabled>'`，Windows cmd 中写为 `"<disabled>"`）。名称无效时会回退到默认值并发出警告 |
| `MCP_TOOL_FETCH_GITHUB_NAME` | `fetchGithubReadme` | 有效的 MCP 工具名称 | 自定义 GitHub README 获取工具名称；设为 `<disabled>` 可禁用工具（bash/zsh 中写为 `'<disabled>'`，Windows cmd 中写为 `"<disabled>"`）。名称无效时会回退到默认值并发出警告 |
| `MCP_TOOL_FETCH_JUEJIN_NAME` | `fetchJuejinArticle` | 有效的 MCP 工具名称 | 自定义掘金文章获取工具名称；设为 `<disabled>` 可禁用工具（bash/zsh 中写为 `'<disabled>'`，Windows cmd 中写为 `"<disabled>"`）。名称无效时会回退到默认值并发出警告 |
| `MCP_TOOL_FETCH_WEB_NAME` | `fetchWebContent` | 有效的 MCP 工具名称 | 自定义通用网页或 Markdown 获取工具名称；设为 `<disabled>` 可禁用工具（bash/zsh 中写为 `'<disabled>'`，Windows cmd 中写为 `"<disabled>"`）。名称无效时会回退到默认值并发出警告 |

**常用配置：**

```bash
# 为受限地区启用代理
USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 npx open-websearch@latest

# 仅在目标网站的证书链异常时使用
FETCH_WEB_INSECURE_TLS=true npx open-websearch@latest

# 优先使用请求，必要时回退到可用的 Playwright
SEARCH_MODE=auto npx open-websearch@latest

# 强制 Bing 搜索仅使用请求模式
SEARCH_MODE=request npx open-websearch@latest

# 将搜索工具重命名为 webSearch
MCP_TOOL_SEARCH_NAME=webSearch npx open-websearch@latest

# 禁用搜索工具
MCP_TOOL_SEARCH_NAME='<disabled>' npx open-websearch@latest

# 完整配置
DEFAULT_SEARCH_ENGINE=duckduckgo ENABLE_CORS=true USE_PROXY=true PROXY_URL=http://127.0.0.1:7890 PORT=8080 npx open-websearch@latest
```

> **注意：** `<disabled>` 包含终端特殊字符。bash/zsh 中应写为 `'<disabled>'`；Windows cmd 中应使用双引号，写为 `"<disabled>"`。

Bing 的浏览器增强回退功能需要手动启用。发布的包已不再内置 Playwright，可以通过以下任一方式配置：

源码开发环境使用 `playwright-core`，可直接复用系统 Chrome/Edge 或连接远程浏览器；需要下载 Chromium 时使用下面的安装命令。

1. 在本地安装 Playwright 客户端及 Chromium：

```bash
npm install playwright-core
npx playwright-core install chromium
SEARCH_MODE=auto npx open-websearch@latest
```

2. 使用精简客户端，复用已有的浏览器程序：

```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_EXECUTABLE_PATH=/path/to/chromium SEARCH_MODE=auto npx open-websearch@latest
```

3. 复用机器上其他位置已有的 Playwright 包：

```bash
PLAYWRIGHT_MODULE_PATH=/absolute/path/to/node_modules/playwright-core SEARCH_MODE=playwright npx open-websearch@latest
```

4. 连接已有的远程浏览器：

```bash
npm install playwright-core
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_WS_ENDPOINT=ws://127.0.0.1:3000/ SEARCH_MODE=auto npx open-websearch@latest
```

5. 通过 CDP 复用本地 Chrome/Chromium 会话：

```bash
npm install playwright-core

# 先启动 Chrome/Chromium 并开启调试端口
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/open-websearch-chrome

# 然后通过 CDP 连接
PLAYWRIGHT_PACKAGE=playwright-core PLAYWRIGHT_CDP_ENDPOINT=http://127.0.0.1:9222 SEARCH_MODE=auto npx open-websearch@latest
```

CDP 连接仅复用浏览器进程；抓取会创建独立 context，不接管已有登录页面或默认 profile。

Windows PowerShell 示例：

```powershell
npm install playwright-core

& "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\open-websearch-chrome"

$env:PLAYWRIGHT_PACKAGE="playwright-core"
$env:PLAYWRIGHT_CDP_ENDPOINT="http://127.0.0.1:9222"
$env:SEARCH_MODE="auto"
npx open-websearch@latest
```

**所有浏览器示例均以已部署受控出口为前提**：配置 `BROWSER_EGRESS_PROXY_URL`，在浏览器所在机器阻止直连并完成验收后设置 `BROWSER_EGRESS_ENFORCED=true`。远程模式必须限制远端出口。可使用仓库提供的[浏览器隔离部署与验收配置](docs/security/browser-egress.zh-CN.md)。仅安装客户端或设置代理 URL 不满足此条件。

各模式的行为：

- `request`：仅通过请求抓取 Bing 结果；搜索工具不提供 `searchMode` 参数或模式选择指引。
- `playwright`：强制使用 Playwright；搜索工具不提供 `searchMode` 参数或模式选择指引。启动时会检查 Playwright 是否可用，配置无效时记录警告；之后搜索会返回明确的 `browser_unavailable` 错误。
- `auto`：检查 Playwright 是否确实可用（客户端模块能实际加载；本地启动时还需存在浏览器程序）。如果可用，搜索工具会提供 `searchMode` 参数（`request` / `auto` / `playwright`），并引导智能体保留默认的 `auto`，仅在请求失败、结果为空或疑似被拦截时使用 `playwright` 重试；否则服务器按请求模式运行。

注意：

- `PLAYWRIGHT_MODULE_PATH` 的优先级高于 `PLAYWRIGHT_PACKAGE`。
- `PLAYWRIGHT_WS_ENDPOINT` 的优先级高于 `PLAYWRIGHT_CDP_ENDPOINT`。
- 使用远程端点时忽略 `PLAYWRIGHT_EXECUTABLE_PATH`；每个任务仍通过 `BROWSER_EGRESS_PROXY_URL` 配置远端 context 的受控代理。`USE_PROXY` / `PROXY_URL` 只控制 Node HTTP 请求。
- Playwright 可用时，被拦截的 CSDN、知乎文章获取请求和通用网页获取请求也可以使用浏览器获取的 Cookie 重试。
- 未配置 Playwright 时，`fetchWebContent` 仅使用请求方式。公开页面仍可能正常获取，但需要浏览器 Cookie 或浏览器渲染 HTML 的页面可能失败。

浏览器状态说明（任务隔离）：

- 复用浏览器进程，每个任务创建独立 context，防护完成后才导航。任务结束关闭整个 context，不跨任务复用页面、Cookie、存储或 worker。
- HTML 抓取、Cookie 采集、Cookie/HTTP 竞速和 Bing 使用相同的 context 工厂；不回退已有默认 context，也不继承个人浏览器的登录状态。
- 默认关闭弹窗、WebSocket、普通 worker、Service Worker 及不需要的实时网络功能。需要这些功能的站点可能受影响；不支持的浏览器防护能力会明确报错。
- 任务与网络策略说明见[浏览器部署文档](docs/security/browser-egress.zh-CN.md)。本地 profile 目录仅用于浏览器进程，不作为网页抓取状态共享边界。

### 本地安装

1. 克隆或下载本仓库。
2. 安装依赖：

```bash
npm install
```

   此步骤仅安装核心 MCP 服务器。浏览器回退功能仍为可选，需要自行安装或连接 Playwright 客户端。

3. 构建服务器：

```bash
npm run build
```

4. 将服务器添加到 MCP 配置：

**Cherry Studio：**

```json
{
  "mcpServers": {
    "web-search": {
      "name": "网页搜索 MCP",
      "type": "streamableHttp",
      "description": "多引擎网页搜索与文章获取",
      "isActive": true,
      "baseUrl": "http://localhost:3000/mcp"
    }
  }
}
```

**VSCode（Claude Dev 扩展）：**

```json
{
  "mcpServers": {
    "web-search": {
      "transport": {
        "type": "streamableHttp",
        "url": "http://localhost:3000/mcp"
      }
    },
    "web-search-sse": {
      "transport": {
        "type": "sse",
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

**Claude Desktop：**

```json
{
  "mcpServers": {
    "web-search": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    },
    "web-search-sse": {
      "type": "sse",
      "url": "http://localhost:3000/sse"
    }
  }
}
```

**NPX 命令行配置：**

```json
{
  "mcpServers": {
    "web-search": {
      "args": [
        "open-websearch@latest"
      ],
      "command": "npx",
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "ALLOWED_SEARCH_ENGINES": "duckduckgo,bing,exa"
      }
    }
  }
}
```

Windows NPX 配置：

```json
{
  "mcpServers": {
    "web-search": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "-y",
        "open-websearch@latest"
      ],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "SYSTEMROOT": "C:/Windows"
      }
    }
  }
}
```

代理与 TLS 说明：

- open-websearch 已在内部禁用 Axios 的环境代理自动检测，仅使用显式配置的 `USE_PROXY` + `PROXY_URL`。
- 当 `USE_PROXY=true` 时，所有基于 Axios 的网络请求都会使用配置的 `PROXY_URL`，不再混用直接请求与环境代理行为。
- 如果 `PROXY_URL` 指向本地规则代理客户端，该客户端仍可决定哪些目标使用 `DIRECT` 直连、哪些通过代理访问。
- 如果 `PROXY_URL` 指向固定的上游代理或境外出口，百度、CSDN、掘金、Linux.do、GitHub 等对地区敏感的网站可能表现出与之前不同的行为。
- 主机上已有的 `HTTP_PROXY` 或 `HTTPS_PROXY` 不再覆盖服务器内部的请求行为。
- Windows 上遇到网站缺少中间 CA 证书时，优先配置 `NODE_EXTRA_CA_CERTS`。
- 仅在别无办法时，对 `fetchWebContent` 的请求阶段使用 `FETCH_WEB_INSECURE_TLS=true`；它会弱化 TLS 验证，但不影响 Playwright 浏览器导航。

**Cherry Studio 本地 STDIO 配置（Windows）：**

```json
{
  "mcpServers": {
    "open-websearch-local": {
      "command": "node",
      "args": ["C:/path/to/your/project/build/index.js"],
      "env": {
        "MODE": "stdio",
        "DEFAULT_SEARCH_ENGINE": "duckduckgo",
        "ALLOWED_SEARCH_ENGINES": "duckduckgo,bing,exa"
      }
    }
  }
}
```

### Docker 部署

使用 Docker Compose 快速部署：

```bash
docker-compose up -d
```

也可以直接使用 Docker：

```bash
docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/aas-ee/open-web-search:latest
```

环境变量配置：

| 变量 | 默认值 | 可选值 | 说明 |
|------|--------|--------|------|
| `ENABLE_CORS` | `false` | `true`、`false` | 启用跨域资源共享（CORS） |
| `CORS_ORIGIN` | `*` | 任意有效来源 | 配置 CORS 允许的来源 |
| `DEFAULT_SEARCH_ENGINE` | `bing` | `bing`、`duckduckgo`、`exa`、`brave`、`baidu`、`csdn`、`linuxdo`、`juejin`、`startpage`、`sogou`、`hackernews` | 默认搜索引擎 |
| `USE_PROXY` | `false` | `true`、`false` | 启用 HTTP 代理 |
| `PROXY_URL` | `http://127.0.0.1:7890` | 任意有效 URL | 代理服务器地址 |
| `FAKE_IP_CIDRS` | 空 | 以逗号分隔的 CIDR 列表 | 将这些网段内的 DNS 返回地址视为合成的虚拟 IP，不因其属于私有网络而阻止访问。直接使用私有或本地目标地址，以及其他私有网络 DNS 返回地址，仍会被阻止 |
| `PORT` | `3000` | 1–65535 | 服务器端口 |

然后在 MCP 客户端中配置：

```json
{
  "mcpServers": {
    "web-search": {
      "name": "网页搜索 MCP",
      "type": "streamableHttp",
      "description": "多引擎网页搜索与文章获取",
      "isActive": true,
      "baseUrl": "http://localhost:3000/mcp"
    },
    "web-search-sse": {
      "transport": {
        "name": "网页搜索 MCP",
        "type": "sse",
        "description": "多引擎网页搜索与文章获取",
        "isActive": true,
        "url": "http://localhost:3000/sse"
      }
    }
  }
}
```

## 使用指南

服务器提供六个工具：`search`、`fetchLinuxDoArticle`、`fetchCsdnArticle`、`fetchGithubReadme`、`fetchJuejinArticle` 和 `fetchWebContent`。

本地守护进程 HTTP API（`serve`、`status`、`GET /health`、`POST /search`、`POST /fetch-*`）详见 [HTTP API 文档](docs/http-api.md)。

### search 工具用法

```typescript
{
  "query": string,        // 搜索关键词
  "limit": number,        // 可选：返回结果数量，默认 10
  "engines": string[],    // 可选：使用的引擎（bing、baidu、linuxdo、csdn、duckduckgo、exa、brave、juejin、startpage、sogou、hackernews），默认使用运行时配置的引擎
  "searchMode": string    // 可选：request、auto 或 playwright，目前仅影响 Bing
}
```

使用示例：

```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "search",
  arguments: {
    query: "搜索内容",
    limit: 3,  // 可选参数
    engines: ["bing", "csdn", "duckduckgo", "exa", "brave", "juejin", "sogou"] // 可选参数，支持多引擎组合搜索
  }
})
```

响应示例：

```json
[
  {
    "title": "搜索结果示例",
    "url": "https://example.com",
    "description": "搜索结果的描述文本……",
    "source": "来源",
    "engine": "使用的引擎"
  }
]
```

### fetchCsdnArticle 工具用法

用于获取 CSDN 博客文章的完整内容。

```typescript
{
  "url": string    // 使用 search 工具获得的 CSDN 搜索结果 URL
}
```

使用示例：

```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchCsdnArticle",
  arguments: {
    url: "https://blog.csdn.net/xxx/article/details/xxx"
  }
})
```

响应示例：

```json
[
  {
    "content": "搜索结果示例"
  }
]
```

### fetchLinuxDoArticle 工具用法

用于获取 Linux.do 论坛文章的完整内容。

```typescript
{
  "url": string    // 使用 search 工具获得的 linuxdo 搜索结果 URL
}
```

使用示例：

```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchLinuxDoArticle",
  arguments: {
    url: "https://xxxx.json"
  }
})
```

响应示例：

```json
[
  {
    "content": "搜索结果示例"
  }
]
```

### fetchGithubReadme 工具用法

用于获取 GitHub 仓库中的 README 内容。

```typescript
{
  "url": string    // GitHub 仓库 URL，支持 HTTPS 和 SSH 格式
}
```

使用示例：

```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchGithubReadme",
  arguments: {
    url: "https://github.com/Aas-ee/open-webSearch"
  }
})
```

支持的 URL 格式：

- HTTPS：`https://github.com/owner/repo`
- 带 .git 后缀的 HTTPS：`https://github.com/owner/repo.git`
- SSH：`git@github.com:owner/repo.git`
- 带参数的 URL：`https://github.com/owner/repo?tab=readme`

响应示例：

```json
[
  {
    "content": "<div align=\"center\">\n\n# Open-WebSearch MCP 服务器……"
  }
]
```

### fetchWebContent 工具用法

直接从公开的 HTTP(S) 链接获取内容，包括 Markdown 文件（`.md`）、普通网页，以及配置 Playwright 后可获取的 JavaScript 渲染页面。

```typescript
{
  "url": string,          // 公开的 HTTP(S) URL
  "maxChars": number,     // 可选：返回内容的最大长度，范围 1000–200000，默认 30000
  "renderMode": string,   // 可选：request、auto（默认）或 browser
  "readability": boolean, // 可选：对 HTML 使用 Mozilla Readability
  "includeLinks": boolean // 可选：保留 Readability 输出中的链接
}
```

`request` 模式不会启动浏览器或使用浏览器 Cookie。`auto` 保留优先请求的行为，仅在需要时使用浏览器辅助。`browser` 直接渲染页面；如果 Playwright 或目标浏览器不可用，会返回明确的错误。初始 URL 和最终 URL 都会接受公开网络安全检查。

浏览器请求在继续执行前会重新验证，但这一过程不会将 DNS 返回地址固定到 Chromium 最终建立的套接字连接。因此，远程 Playwright/CDP 端点必须自行执行可信的 DNS 与出口访问策略。

使用示例：

```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchWebContent",
  arguments: {
    url: "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
    maxChars: 12000,
    renderMode: "auto"
  }
})
```

响应示例：

```json
{
  "url": "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
  "finalUrl": "https://raw.githubusercontent.com/Aas-ee/open-webSearch/main/README.md",
  "contentType": "text/plain; charset=utf-8",
  "title": "",
  "retrievalMethod": "request",
  "truncated": false,
  "content": "# Open-WebSearch MCP 服务器……"
}
```

### fetchJuejinArticle 工具用法

用于获取掘金文章的完整内容。

```typescript
{
  "url": string    // 搜索结果中的掘金文章 URL
}
```

使用示例：

```typescript
use_mcp_tool({
  server_name: "web-search",
  tool_name: "fetchJuejinArticle",
  arguments: {
    url: "https://juejin.cn/post/7520959840199360563"
  }
})
```

支持的 URL 格式：

- `https://juejin.cn/post/{article_id}`

响应示例：

```json
[
  {
    "content": "🚀 开源 AI 联网搜索工具：Open-WebSearch MCP 全新升级，支持多引擎 + 流式响应..."
  }
]
```

## 使用限制

本工具通过抓取多个引擎的搜索结果工作，请注意以下限制：

1. **频率限制**：
    - 短时间内搜索过多，可能导致所用引擎暂时阻止请求。
    - 建议保持合理的搜索频率，按需设置 `limit` 参数，并在必要时增加搜索间隔。

2. **结果准确性**：
    - 依赖相应引擎的 HTML 结构，引擎更新后可能失效。
    - 部分结果可能缺少描述等元数据。
    - 复杂的搜索运算符可能无法按预期工作。

3. **法律条款**：
    - 本工具仅供个人使用。
    - 请遵守相应引擎的服务条款。
    - 根据实际使用场景实施适当的频率限制。

4. **搜索引擎配置**：
    - 可通过 `DEFAULT_SEARCH_ENGINE` 环境变量设置默认搜索引擎。
    - 支持的引擎标识：`bing`、`duckduckgo`、`exa`、`brave`、`baidu`、`csdn`、`linuxdo`、`juejin`、`startpage`、`sogou`、`hackernews`。
    - 搜索特定网站时使用默认引擎。

5. **代理配置**：
    - 某些搜索引擎在特定地区不可用时，可配置 HTTP 代理。
    - 使用环境变量 `USE_PROXY=true` 启用代理。
    - 使用 `PROXY_URL` 配置代理服务器地址。
    - 使用 Clash 的虚拟 IP（fake-ip）或 TUN 模式时，通过 `FAKE_IP_CIDRS` 配置合成 DNS 地址范围，例如 `198.18.0.0/15`。

## 参与贡献

欢迎提交问题报告和功能改进建议！

### 贡献者指南

如果要派生本仓库并发布自己的 Docker 镜像，需要完成以下配置。

#### GitHub 机密配置

如需自动构建和发布 Docker 镜像，请在 GitHub 仓库设置中添加以下机密（设置 → 机密和变量 → Actions）：

**必需的机密：**

- `GITHUB_TOKEN`：由 GitHub 自动提供，无需手动设置。

**可选的机密（用于阿里云 ACR）：**

- `ACR_REGISTRY`：阿里云容器镜像服务地址，例如 `registry.cn-hangzhou.aliyuncs.com`。
- `ACR_USERNAME`：阿里云 ACR 用户名。
- `ACR_PASSWORD`：阿里云 ACR 密码。
- `ACR_IMAGE_NAME`：ACR 中的镜像名称，例如 `your-namespace/open-web-search`。

#### CI/CD 工作流

仓库包含 GitHub Actions 工作流（`.github/workflows/docker.yml`），可自动执行以下操作：

1. **触发条件**：
    - 推送到 `main` 分支。
    - 推送版本标签（`v*`）。
    - 手动触发工作流。

2. **构建并推送到**：
    - GitHub 容器镜像仓库（ghcr.io）：始终启用。
    - 阿里云容器镜像服务：仅在配置 ACR 机密后启用。

3. **镜像标签**：
    - `ghcr.io/your-username/open-web-search:latest`
    - `your-acr-address/your-image-name:latest`（配置 ACR 时）

#### 派生与发布步骤

1. **派生仓库**到自己的 GitHub 账号。
2. **配置机密**（需要发布到 ACR 时）：
    - 在派生仓库中打开设置 → 机密和变量 → Actions。
    - 添加上方列出的 ACR 相关机密。
3. **推送更改**到 `main` 分支，或创建版本标签。
4. **GitHub Actions 会自动构建并推送** Docker 镜像。
5. **使用自己的镜像**，更新 Docker 命令：

   ```bash
   docker run -d --name web-search -p 3000:3000 -e ENABLE_CORS=true -e CORS_ORIGIN=* ghcr.io/your-username/open-web-search:latest
   ```

#### 注意事项

- 未配置 ACR 机密时，工作流仅发布到 GitHub 容器镜像仓库。
- 确保 GitHub 仓库已启用 Actions。
- 工作流会使用转换为小写的 GitHub 用户名作为 GHCR 镜像名称中的用户名。

<div align="center">
