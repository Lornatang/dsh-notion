# dsh-notion

[简体中文](README.zh-CN.md)

Connect Notion's official MCP server to DeepSeek Harness (DSH). The plugin
registers Notion's available tools in agent sessions and adds a Notion
connection page to DSH Web. Ask an agent to search or work with pages,
databases, and other content supported by your Notion account.

**Requires:** Node.js 22.19+, DSH 0.2.2-rc.2+, and a DSH Web profile.
This is a community project, not a Notion or DeepSeek product.

## Install from GitHub

```bash
dsh plugin --profile web add https://github.com/Lornatang/dsh-notion/archive/refs/heads/main.tar.gz
```

Restart DSH, or start the Web profile with `dsh web --no-open`. Replace `web`
with the name of your profile if necessary. The installation URL tracks the
repository's `main` branch.

To update, use a URL containing the latest commit ID and then restart DSH.
Repeating the same branch archive URL may reuse a cached older package:

```bash
revision=$(git ls-remote https://github.com/Lornatang/dsh-notion.git refs/heads/main | cut -f1)
dsh plugin --profile web add "https://github.com/Lornatang/dsh-notion/archive/${revision}.tar.gz"
```

To build and install a local package instead:

```bash
git clone https://github.com/Lornatang/dsh-notion.git
cd dsh-notion
npm ci
npm run build
npm pack --ignore-scripts
dsh plugin --profile web add "$PWD/lornatang-dsh-notion-0.1.0.tgz"
```

## Connect

1. Open **Settings → Notion** in DSH Web.
2. Select **Authorize in Notion**, then sign in and approve the connection in
   Notion. If the connection has expired, select **Connect Notion** first.
3. Return to DSH; the page shows **Connected** and the number of available
   tools. Ask an agent to search, read, or update your Notion content.

The plugin uses OAuth 2.0 authorization code flow with PKCE. It never asks for
your Notion password. Notion decides which tools are available and applies
your workspace permissions. An Enterprise workspace may require an admin to
approve this MCP client.

Tools are registered as `mcp__notion__…`. The plugin also exposes MCP resource
listing and reading tools when the server supports resources, so an agent can
read documentation referenced by Notion tools. The available tools and their
schemas come from Notion at connection time. Changes take effect after
reconnecting. Image and other non-text responses are shown as placeholders.

## Credential security

OAuth tokens and the PKCE verifier are encrypted with AES-256-GCM in the active
DSH profile's `data/dsh-notion-*.json` file. On POSIX systems the file is
restricted to its owner. The random encryption key is kept in the operating
system credential store: macOS Keychain, Windows Credential Manager, or the
Linux Secret Service. On Linux a running, unlocked Secret Service is required;
the kernel keyring is not used as a fallback. Protect the DSH host and account:
any program that can access the unlocked credential store and profile file can
use these credentials. On Windows, restrict the profile directory with ACLs.

For headless or container deployments without a credential store, supply a
persistent, secret 32-byte key through `DSH_NOTION_ENCRYPTION_KEY`, encoded as
standard Base64. For example, generate a value with `openssl rand -base64 32`
and configure it in your service's secret manager before starting DSH. Keep
the same value across restarts; do not commit it or put it in the DSH profile.
Changing the key or moving the profile to another path makes the existing
credential file unreadable. Restore the original key and path, or stop DSH,
remove that credential file, and reconnect. A missing or inaccessible secure
key store causes the connection to fail; the plugin does not fall back to
plaintext credential storage. Run only one DSH process per profile.

The callback listener binds only to `127.0.0.1` on the DSH host. For a remote
host, forward the callback port to the browser's machine. Keep the configured
port available and stable: if it is in use the plugin chooses a free port,
which can require a new authorization. The server and discovered OAuth
endpoints must use the same HTTPS origin. HTTP is accepted only for a loopback
mock server used in development.

**Disconnect** removes locally stored credentials and registered tools. It does
not revoke a Notion grant; revoke it separately in Notion's connection settings.
The connected agent acts with your Notion permissions, including permissions to
change content. DSH's normal tool permissions still apply. The plugin does not
bridge MCP prompts or binary resource content as native media.

## Configuration

Edit `~/.dsh/profiles/web/cordis.patch.yml` (or use `$DSH_HOME` in place of
`~/.dsh`). Restart DSH after changing the `notion` entry:

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

| Option | Default | Purpose |
| --- | --- | --- |
| `serverName` | `notion` | Tool namespace and credential-store identity. |
| `url` | Notion MCP URL | MCP server; the default is Notion's official endpoint. |
| `redirectPort` | `3335` | Loopback OAuth callback port; `0` selects an available port. |
| `toolCallTimeoutMs` | `60000` | Maximum time for each MCP tool or resource request. |
| `authorizationTimeoutMs` | `300000` | Time allowed to complete authorization. |
| `autoOpenBrowser` | `false` | Also open the authorization URL on the DSH host when Connect is selected. |

## Troubleshooting

- **Secure key storage unavailable:** Unlock the system keychain or configure a
  persistent `DSH_NOTION_ENCRYPTION_KEY` as described above. On Linux, check
  the Secret Service and D-Bus session.
- **Cannot decrypt credentials:** Restore the original key and profile path, or
  remove the encrypted credential file while DSH is stopped and reconnect.
- **Authorization does not return:** Check the callback port and any SSH port
  forwarding. If the authorization timed out, choose **Connect Notion** again.
- **Tools are missing or a request is denied:** Check Notion MCP availability,
  workspace administrator policy, your Notion permissions, and the DSH log.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run test:dsh
```

`test:dsh` installs the package into a temporary DSH Web profile and exercises
OAuth against a local mock. It requires DSH 0.2.2-rc.2 and `pnpm` on `PATH`.
A browser check is run when Chrome is available, and is required in CI. These
tests do not read or modify a real Notion workspace.

References: [Notion MCP client integration](https://github.com/makenotion/notion-cookbook/blob/main/docs/mcp-client-integration.md),
[Notion MCP permissions](https://www.notion.com/help/notion-mcp).

[Apache-2.0](LICENSE)
