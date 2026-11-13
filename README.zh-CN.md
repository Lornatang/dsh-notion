# dsh-notion

[English](README.md)

将 Notion 官方 MCP 服务接入 DeepSeek Harness（DSH）。插件在 DSH Web 中提供
Notion 连接设置，并向智能体会话注册 Notion 提供的工具，可按账户权限搜索、读取和
管理页面、数据库等内容。

需要 Node.js 22.19+、DSH 0.2.2-rc.2+ 和 DSH Web 配置。本项目由社区维护，
不属于 Notion 或 DeepSeek。

## 安装

```bash
dsh plugin --profile web add https://github.com/Lornatang/dsh-notion/archive/refs/heads/main.tar.gz
```

重启 DSH，或使用 `dsh web --no-open` 启动 Web 配置。如果配置名称不是 `web`，
请替换命令中的配置名称。更新时再次执行安装命令并重启；该地址跟随仓库的 `main` 分支。

也可以从源码构建并安装本地压缩包：

```bash
git clone https://github.com/Lornatang/dsh-notion.git
cd dsh-notion
npm ci
npm run build
npm pack --ignore-scripts
dsh plugin --profile web add "$PWD/lornatang-dsh-notion-0.1.0.tgz"
```

## 连接

1. 在 DSH Web 打开 **设置 → Notion**。
2. 点击 **前往 Notion 授权**，在 Notion 完成登录和授权；连接超时后可先点击
   **连接 Notion** 重新发起。
3. 返回 DSH，连接成功后会显示可用工具数量。随后可以让智能体搜索、读取或更新
   Notion 内容。

插件采用 OAuth 2.0 授权码流程和 PKCE，不需要输入 Notion 密码。工具及其参数由
Notion 在连接时提供，具体功能取决于 Notion 服务、账户和工作区权限；工具更新后
需要重新连接。支持资源的服务器还会提供 MCP 资源列表和读取工具。企业工作区可能
需要管理员批准此 MCP 客户端。工具名称以 `mcp__notion__` 开头。

## 凭据与安全

OAuth 令牌和 PKCE 验证值使用 AES-256-GCM 加密后，保存在当前 DSH 配置的
`data/dsh-notion-*.json` 中。POSIX 系统上的文件权限限制为仅所有者可访问；Windows
用户应通过 ACL 限制配置目录。随机加密密钥保存在系统凭据存储中：macOS 钥匙串、
Windows 凭据管理器或 Linux Secret Service。Linux 需要可用且已解锁的 Secret
Service，插件不会退回到内核临时钥匙串或明文保存。

无系统凭据存储的服务器或容器可以设置环境变量 `DSH_NOTION_ENCRYPTION_KEY`，
值为 32 字节密钥的标准 Base64 编码。例如可用 `openssl rand -base64 32` 生成，
再通过服务的密钥管理机制提供。重启时必须使用相同密钥；不要提交到仓库，也不要
写入 DSH 配置。更换密钥或移动配置目录会导致现有凭据无法解密，应恢复原密钥和路径，
或者停止 DSH 后删除该加密凭据文件并重新授权。每个配置只运行一个 DSH 进程。

授权回调只监听 DSH 主机上的 `127.0.0.1`。DSH 运行在远程主机时，请将回调端口
转发到浏览器所在设备。尽量保持端口固定；端口被占用时会选择其他空闲端口，可能需要
重新授权。服务和发现到的 OAuth 端点必须位于同一 HTTPS 来源；HTTP 仅用于本机回环
地址上的测试服务。

在设置中断开连接会删除本地凭据和注册的工具，但不会撤销 Notion 端授权；如需撤销，
请同时前往 Notion 的连接设置。智能体可以使用该 Notion 账户已有的内容修改权限，
DSH 自身的工具权限机制仍然适用。请保护 DSH 运行账户和主机。

## 配置

编辑 `~/.dsh/profiles/web/cordis.patch.yml` 中的 `notion` 项（如使用 `$DSH_HOME`，
请替换 `~/.dsh`），然后重启 DSH：

```yaml
- id: notion
  config:
    serverName: notion
    url: 'https://mcp.notion.com/mcp'
    redirectPort: 3335
    toolCallTimeoutMs: 60000
    authorizationTimeoutMs: 300000
    autoOpenBrowser: false
```

| 配置项 | 默认值 | 作用 |
| --- | --- | --- |
| `serverName` | `notion` | 工具命名空间和凭据身份。 |
| `url` | Notion 官方 MCP 地址 | MCP 服务地址。 |
| `redirectPort` | `3335` | 本地 OAuth 回调端口；`0` 表示自动选择。 |
| `toolCallTimeoutMs` | `60000` | 单次工具或资源请求超时，单位为毫秒。 |
| `authorizationTimeoutMs` | `300000` | 完成授权的时间限制，单位为毫秒。 |
| `autoOpenBrowser` | `false` | 点击连接时同时在 DSH 主机打开授权页。 |

## 开发与验证

```bash
npm ci
npm run typecheck
npm test
npm run test:dsh
```

`test:dsh` 在临时 DSH Web 配置和本地模拟服务中验证安装与 OAuth，不会读取或修改
真实 Notion 工作区；需要 DSH 0.2.2-rc.2、`pnpm` 和可用的 Chrome（本地没有 Chrome
时跳过浏览器检查，CI 中必须运行）。

[Apache-2.0](LICENSE)
