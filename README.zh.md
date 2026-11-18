---
description: "在 dsh profile 中接入 Notion 官方 MCP 服务器：OAuth 连接、它保存的加密凭证，以及服务器通告的全部工具。"
kind: "package-bundle"
---

# @lornatang/dsh-notion

[English](README.md) | 中文

## 概要

`dsh-notion` 把一个 dsh profile 连接到 Notion 官方 MCP 服务器。它执行 OAuth 流程，把凭证保存在 profile 内的加密文件中、密钥放在宿主凭证库，并注册服务器通告的全部工具，让 agent 以授权账号的权限搜索、读取和更新工作区内容。用 `add` 命令安装，在 设置 → Notion 中授权一次，再用同样的命令移除。边界：每行一个 Notion 连接，凭证绑定 profile 路径与宿主钥匙串，本身不提供任何工具或提示词文本。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发者注记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

这一层只负责连接：工具是否存在、schema 是什么由 MCP 服务器决定，工具能改什么由 Notion 账号决定，profile 自身的工具权限仍然对每次调用生效。把它安装到需要访问 Notion 的会话所在的 Web profile。

### 安装到 profile

```text
dsh plugin --profile <name> add @lornatang/dsh-notion
dsh plugin --profile <name> remove @lornatang/dsh-notion
```

安装仅发布到 GitHub 的 0.1.9 版本，请运行 `dsh plugin --profile <name> add https://github.com/Lornatang/dsh-notion/releases/download/v0.1.9/lornatang-dsh-notion-0.1.9.tgz`。npm 仓库中的版本可能较旧。

`add` 命令把 bundle 组合进 profile：profile 的 `cordis.patch.yml` 增加一条 insert 行，行 id 为 `notion`，其 `config` 从 `serverName: notion`、`url: https://mcp.notion.com/mcp`、`redirectPort: 3335` 和 `autoOpenBrowser: false` 开始。该行没有写 `toolCallTimeoutMs` 和 `authorizationTimeoutMs`，因此这两个字段采用 schema 默认值 60000 ms 和 300000 ms。`package.json` 通过 `dsh.bundle.patch` 声明这个文件，同一清单还声明了渲染设置页面的客户端入口。

`add` 或 `remove` 之后重启 DSH：行在 profile 加载时组合，桥接随行一起启动。在 Web profile 中打开 设置 → Notion，页面显示连接状态，并驱动注册工具的那个桥接。

全新 profile 中还没有凭证文件，桥接先绑定 `http://127.0.0.1:<redirectPort>/callback`，再连接 MCP 端点，收到授权质询。页面随后显示 Waiting for Notion authorization 和 Authorize in Notion 链接；启动过程本身从不打开浏览器，`autoOpenBrowser` 只影响 Connect 操作。在 Notion 中批准连接后，回调送来授权码，凭证写入加密文件，服务器工具被注册，页面显示 Connected 与工具数量。若浏览器未在 `authorizationTimeoutMs`（默认五分钟）内返回，本次尝试以 Connection failed 结束，点击 Connect Notion 开始新的尝试。

### 你会得到

| 暴露面 | 提供方 |
|---|---|
| Notion 通告的每个工具对应的 `mcp__notion__<tool>` | 宿主入口，`src/bridge.ts` |
| 服务器通告 resources 时的 `mcp__notion__dsh_list_resources`、`mcp__notion__dsh_list_resource_templates` 和 `mcp__notion__dsh_read_resource` | 宿主入口，`src/bridge.ts` |
| 设置 → Notion 页面 | 客户端入口，`src/client/index.tsx`，槽位 `settings.section`，order 31 |
| `GET /plugins/notion/status`、`POST /plugins/notion/connect` 和 `POST /plugins/notion/disconnect` | 宿主入口，`src/routes.ts` |
| `<profile>/data/dsh-notion-<serverName>-<hash>.json` | 宿主入口，`src/store.ts` |

每个注册工具都命名为 `mcp__notion__<name>`。字母、数字、连字符和下划线以外的字符会变成下划线；名称因此被改写或超过 64 个字符时，取前 51 个字符、一个下划线和服务器名与工具名的 12 位摘要。描述和输入 schema 来自服务器，服务器改变工具列表时注册结果随之改变。工具结果是服务器的 content 数组：文本块以空行连接，其他类型的块显示为 `[type content]`。工具返回错误时抛出；声明了 output schema 的工具必须返回 `structuredContent`，该内容在结果渲染前被校验。

服务器通告 resources 能力时，三个资源工具加入同一前缀：`dsh_list_resources` 和 `dsh_list_resource_templates` 接受可选的续传游标，`dsh_read_resource` 要求精确的 URI。它们的结果序列化为 JSON 文本，资源字节不会被转成原生媒体。

设置页面渲染标题 Notion 与副标题 Connect your Notion workspace to DSH、一个 Connection 标签、一张带状态点的状态卡（Loading、Not connected、Connecting、Waiting for Notion authorization、Connected 或 Connection failed，并显示可用工具数量）、一段提示（授权期间切换为授权提醒）、桥接报告错误时的错误提示，以及操作项：Authorize in Notion（授权期间指向授权 URL 的链接）、Connect Notion、Disconnect、Refresh status，和帮助链接 Learn about Notion MCP permissions and administration。页面每三秒轮询 `GET /plugins/notion/status`，在任何浏览器语言下都保持英文。

三个路由位于 DSH 连接栅栏之后：连接服务缺失时返回 503，被栅栏拒绝的请求以栅栏自身的状态码返回。Connect 与 Disconnect 返回设置页面渲染的同一份状态快照。

### 凭证

OAuth 令牌、注册的客户端信息和 PKCE verifier 一起存放在一个文件中：`<profile>/data/dsh-notion-<serverName>-<sha256(url) 前 12 位十六进制>.json`，采用 AES-256-GCM 信封（`version` 为 1、algorithm 为 `aes-256-gcm`、IV、tag 与密文），文件路径作为附加认证数据。修改 `serverName` 或 `url` 会选中另一个文件。

32 字节密钥来自 `DSH_NOTION_ENCRYPTION_KEY`（恰好 32 字节的标准 Base64），该变量未设置时来自操作系统凭证库中的 `@napi-rs/keyring`：macOS Keychain、Windows 凭据管理器或 Linux Secret Service。钥匙串条目使用服务名 `dsh-notion`，以文件路径的 SHA-256 作为账号。没有明文回退：读不到也创建不了密钥时，连接以 `notion: secure key storage is unavailable; unlock the system keychain or set DSH_NOTION_ENCRYPTION_KEY to a persistent base64-encoded 32-byte key` 失败。

在 POSIX 上，数据目录以 `0700` 创建并检查是否有其他属主以及组或其他人可写，文件为 `0600`、以 `O_NOFOLLOW` 打开、必须是硬链接数为 1 的普通文件，并以原子方式替换。Windows 跳过模式与属主检查，因此需要用 ACL 限制 profile 目录。每个 profile 只运行一个 DSH 进程：包内没有任何机制协调第二个写入者。

无头或容器主机上，在 DSH 启动前把 `DSH_NOTION_ENCRYPTION_KEY` 设为持久密钥，例如来自 `openssl rand -base64 32`，并在重启后保持相同的值和 profile 路径。改动任一项都会让已有文件无法读取；恢复原值，或停止 DSH、删除该文件后重新连接。Disconnect 删除加密文件、在使用钥匙串时删除钥匙串条目并注销工具；它不会撤销授权，授权仍列在 Notion 账号设置中。

### 配置

bundle 自带下面的行，profile 只需列出与它不同的部分。加载器按 `src/config.ts` 校验每个字段，遇到非法值会在启动时拒绝，而不是替换成默认值。

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: notion
  config:
    serverName: notion
    url: 'https://mcp.notion.com/mcp'
    redirectPort: 3335
    autoOpenBrowser: false
```

不带 `config` 的 `notion` 行使用这些默认值：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `serverName` | `notion` | 工具前缀与凭证标识；1–64 个字母、数字、连字符或下划线。 |
| `url` | `https://mcp.notion.com/mcp` | MCP 端点；除非主机是回环地址，否则要求 HTTPS。 |
| `redirectPort` | `3335` | 回环 OAuth 回调端口，0–65535；`0` 表示自动选择空闲端口。 |
| `toolCallTimeoutMs` | `60000` | 连接、工具发现、工具与资源调用以及每个传输请求的期限；至少 1 ms，无上限。 |
| `authorizationTimeoutMs` | `300000` | 浏览器返回授权码的允许时间；至少 1000 ms。 |
| `autoOpenBrowser` | `false` | 选择 Connect Notion 时在 DSH 主机上打开授权 URL，启动时不打开。 |

回调 URL 属于已保存的凭证。修改 `redirectPort`，或让临时端口 `0` 选了另一个端口，会使已保存的重定向 URI 失效，客户端注册、令牌和 PKCE verifier 被丢弃，下次启动需要重新授权。MCP 端点与每个 OAuth 端点必须同源；离开该源的请求会被拒绝，纯 HTTP 只在服务器为回环地址时接受。

### 故障排查

- **安全密钥存储不可用** — 解锁操作系统钥匙串，检查 Linux Secret Service 与其 D-Bus 会话，或设置 `DSH_NOTION_ENCRYPTION_KEY`。
- **已保存的凭证无法解密** — 恢复原来的密钥与 profile 路径，或停止 DSH、删除凭证文件后重新连接。
- **授权不返回** — 确认 `redirectPort` 在 DSH 主机上空闲，DSH 运行在远程机器时确认该端口已转发；超时后选择 Connect Notion。
- **工具缺失或调用被拒绝** — 检查 Notion MCP 可用性、工作区管理员策略、账号的 Notion 权限以及 DSH 日志。
- **网络中断后连接失败** — 选择 Connect Notion；仍然有效的凭证会被复用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内幕 — 点击展开</summary>

bundle 在 `package.json` 中声明了两半：宿主入口由 `dsh.bundle.patch` 指定的行挂载，客户端入口以 `./client` 导出，由 `dsh.client.inject` 在 `platform: web` 下接入 UI 槽位包与设置包。宿主模块以 `notion` 注册并注入 `tools` 服务，客户端模块注入 `slots`。

`apply` 用 `serverName`、`url` 和宿主报告的 profile patch 路径构造凭证存储，创建桥接，注册 dispose effect，并在 Web 服务器（或 HTTP 服务器）与连接服务都存在时绑定 `/plugins/notion` 路由，这些服务被替换时重新绑定。随后启动桥接：加载存储、绑定回环回调监听、在回调 URL 变化时清除已保存的客户端注册、令牌与 PKCE verifier、把新的回调 URL 写回存储，然后连接。遇到 401 时运行 SDK 授权流程并发布授权 URL；桥接最多等待 `authorizationTimeoutMs` 让回环回调返回，交换授权码并重试连接。连接成功后注册工具并报告 `ready`；第二次失败报告 `error` 与页面显示的消息。

每个传输请求都经过一个 fetch 包装器：要求 HTTPS（允许回环 HTTP），要求目标源等于配置的服务器源，对每个请求施加 `toolCallTimeoutMs`，解码后的响应上限为 16 MiB，并把流事件限制为每十秒 1000 个、服务器打开的 event stream 限制为每十秒 8 个。工具发现按游标遍历页面，受 8 MiB 与 1000 个工具的预算约束，拒绝重名，并为每个工具注册一个定义：execute 调用服务器工具、错误结果抛出、工具声明 output schema 时要求并校验 `structuredContent`，JSON Schema 校验在 worker 线程中隔离执行。

回调监听只绑定 `127.0.0.1`。客户端 UI 文案固定为英文，设置页是单个 `settings.section` 行。Disconnect 中止连接、关闭客户端、注销工具并销毁已保存的凭证；卸载 profile 只释放桥接并保留凭证供下次启动使用。

| 源文件 | 内容 |
|---|---|
| `cordis.patch.yml` | 这一层：一条 insert 行，行 id `notion`，服务器默认值。 |
| `src/index.ts` | `apply`：构造存储与桥接、注册 effect、绑定路由、启动。 |
| `src/config.ts` | 六个配置字段、schema 范围与默认值。 |
| `src/bridge.ts` | 连接生命周期、授权等待、工具注册与命名、传输限制、状态快照。 |
| `src/oauth.ts` | 同源 fetch 守卫、回环回调服务器、带 PKCE、state 和客户端元数据的 OAuth provider。 |
| `src/store.ts` | 凭证文件路径、AES-256-GCM 信封、钥匙串或环境变量密钥、文件加固。 |
| `src/routes.ts` | `/plugins/notion` 的状态、连接与断开路由，栅栏与 503 处理。 |
| `src/response-limit.ts` | 16 MiB 解码响应上限与单事件流上限。 |
| `src/output-validator.ts`、`src/output-validator-worker.ts` | 延迟执行、worker 隔离的结构化工具输出 JSON Schema 校验。 |
| `src/open-url.ts` | 在主机上打开授权 URL，仅 HTTPS 或回环 HTTP。 |
| `src/client/index.tsx` | 设置 → Notion 区块：槽位注册、状态轮询、操作项。 |
| `tests/*.test.mjs` | 针对 mock MCP 服务器的桥接、入口、语言与安全测试套件。 |

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [CHANGELOG.md](CHANGELOG.md) — 0.1.0 到 0.1.4 的发布历史。
- [scripts/verify-dsh.mjs](scripts/verify-dsh.mjs) — 端到端检查：把打包后的 bundle 安装到临时 profile、启动带 OAuth 的 mock MCP 端点、通过 Chrome 驱动 Web UI，并断言保存的凭证已加密。
- [Notion MCP 权限与管理](https://www.notion.com/help/notion-mcp) — 同意界面授予什么，以及工作区管理员如何管控。
- [DeepSeek Harness 配置目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — 这一层的行所遵循的加载器语义。
- [NOTICE](NOTICE) — 部分内容改编自 dsh-atlassian-bridge。
- [Apache-2.0 许可证](LICENSE)。

-----

<a id="model-experience"></a>
## 模型体验

间接地，通过 Notion 服务器通告的工具：每个注册工具把自己的名称、描述和 JSON 输入 schema 提供给模型可调用的工具定义，工具结果以文本返回。

#### KV Cache 影响

工具定义属于请求前缀，因此连接会加入每个已注册 Notion 工具的 schema，断开则移除；工具集合不变期间前缀稳定，其之前的缓存 token 可复用。重连发现不同的工具列表，或 `serverName` 改变导致 `mcp__notion__` 前缀移动，会从第一个受影响的定义起改变前缀，并使之后的缓存 token 失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

这些限制说明这一层何时不适用，以及它对周围 profile 的要求。

- **每行一个连接** — 凭证文件以 `serverName` 和 URL 摘要为键，第二个连接需要另一行并给它自己的 `serverName`；两个值都相同的两行共享一份凭证。
- **回调端口必须在启动时空闲** — 监听在连接前绑定 `127.0.0.1:<redirectPort>`，端口被占用会让该行停在 Connection failed；页面的 Connect 操作会重试监听，端口持续被占用时仍需重启 DSH 才能恢复。
- **回调 URL 必须保持稳定** — 修改 `redirectPort`，或让 `0` 选了另一个端口，都会让已保存的重定向 URI 失效，客户端注册、令牌和 PKCE verifier 被丢弃，需要重新授权。
- **授权在五分钟后超时** — `authorizationTimeoutMs` 默认为 300000 ms；浏览器未在该窗口内返回时，本次尝试以 Connection failed 结束，Connect Notion 会开始新的尝试。
- **凭证绑定 profile 路径与密钥** — 文件路径是认证数据，钥匙串条目以该路径的摘要为键，因此移动 profile 或修改 `DSH_NOTION_ENCRYPTION_KEY` 会让文件无法读取，且没有明文回退。
- **无头主机需要自备密钥** — 没有已解锁的操作系统凭证库（Linux 上是 Secret Service）时，在 `DSH_NOTION_ENCRYPTION_KEY` 持有持久 Base64 32 字节密钥之前，每次连接都会失败；Windows 跳过模式与属主检查，因此 profile 目录需要 ACL。
- **Disconnect 只在本地生效** — 它删除加密文件、钥匙串条目和已注册工具，但授权会留在 Notion 账号中，直到在 Notion 的连接设置里撤销。
- **每次工具调用都带工具超时** — `toolCallTimeoutMs`（默认 60 秒）约束工具调用与发现请求，但不约束服务器打开的 GET event stream，该流会保持到连接关闭；十秒内超过八次这样的打开会让桥接降为 Connection failed。

<a id="dev-note"></a>
### 开发者注记

<details>
<summary>维护者工作上下文 — 点击展开</summary>

`npm run build` 依次执行 `clean`、把宿主项目编译到 `lib` 与 `lib/types`、把客户端项目编译到 `lib/client-build` 与 `lib/types/client`，再运行 `scripts/bundle-client.mjs`，把编译后的客户端包装成 `window.__ModuleLoader__` bundle 写入 `lib/client.js`。`lib` 已提交，CI 运行 `git diff --exit-code -- lib`，因此任何源码改动都要重新构建并提交它。`npm run typecheck` 只检查两个项目、不产出文件。`npm test` 先构建，再运行 `node --test tests/*.test.mjs`；`npm run test:dsh` 运行 `scripts/verify-dsh.mjs`，需要真实的 DSH 二进制（`DSH_TEST_BINARY`）、Chrome（`CHROME_PATH`）与本地 mock MCP 端点，因此是独立的 Linux CI 任务；Windows 上 DSH 启动器是 `dsh.cmd`，而脚本不通过 shell 启动它，所以不在那里运行。`prepack` 会运行测试套件。

`engines` 要求 Node.js 22.19 或更新；唯一的 peer 依赖是 `@deepseek-ai/cordis ~4.1.0`。凭证文件格式是 version 1 的 AES-256-GCM 信封，AAD 为文件路径，密钥位于操作系统凭证库或 `DSH_NOTION_ENCRYPTION_KEY`，因此格式变更在提升版本号前需要升级路径。设置页文案由 `tests/language.test.mjs` 断言为英文。

</details>
