# dsh-notion

Connect Notion's official MCP server to DeepSeek Harness (DSH). The plugin
registers Notion's available tools in agent sessions and adds a Notion
connection page to DSH Desktop and Web. Ask an agent to search or work with pages,
databases, and other content supported by your Notion account.

**Requires:** Node.js 22.19+, DSH 0.2.2-rc.2+, and a Web-compatible profile.
This is a community project, not a Notion or DeepSeek product.

## Install

For DSH Desktop, install into the `desktop` profile:

```bash
dsh plugin --profile desktop add @lornatang/dsh-notion
```

For the default Web profile, replace `desktop` with `web`; use your profile's
name if it differs. Restart DSH, or start Web with `dsh web --no-open`. Use the
same command to update the package and restart DSH; profile settings and
credentials are retained.

## Connect

1. Open **Settings → Notion** in DSH Desktop or Web.
2. Select **Authorize in Notion**, then sign in and approve the connection in
   Notion. If the connection has expired, select **Connect Notion** first.
3. Return to DSH; the page shows **Connected** and the number of available
   tools. Ask an agent to search, read, or update your Notion content.

The plugin uses OAuth 2.0 authorization code flow with PKCE. It never asks for
your Notion password. Notion decides which tools are available and applies
your workspace permissions. Review the Notion consent screen: access may also
include workspace members and connected applications. An Enterprise workspace
may require an admin to approve this MCP client.

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
server.

**Disconnect** removes locally stored credentials and registered tools. It does
not revoke a Notion grant; revoke it separately in Notion's connection settings.
The connected agent acts with your Notion permissions, including permissions to
change content. DSH's normal tool permissions still apply. The plugin does not
bridge MCP prompts or binary resource content as native media.

MCP and OAuth responses are limited to 16 MiB after decompression; streaming
responses use the same limit per event. Structured tool output is validated in
an isolated worker with a maximum five-second budget (or the configured tool
timeout, whichever is shorter). Oversized responses and validation timeouts
fail instead of blocking DSH; narrow a request if a legitimate result exceeds
the limit.

## Configuration

Edit `~/.dsh/profiles/<profile>/cordis.patch.yml` (or use `$DSH_HOME` in place
of `~/.dsh`). Use `desktop` for the standard Desktop profile and `web` for the
default Web profile. Restart DSH after changing the `notion` entry:

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
- **Connection failed after a network interruption:** Select **Connect Notion**
  to reconnect. Existing credentials are reused when still valid.

## Uninstall

Disconnect in **Settings → Notion** first to remove local credentials, then:

```bash
dsh plugin --profile desktop remove @lornatang/dsh-notion
```

Use `web` or your custom profile name as appropriate, then restart DSH.
Disconnecting locally does not revoke the Notion grant; manage that separately
in Notion. If already uninstalled, stop DSH before removing the corresponding
`data/dsh-notion-*.json` file from the affected profile.

References: [Notion MCP client integration](https://github.com/makenotion/notion-cookbook/blob/main/docs/mcp-client-integration.md),
[Notion MCP permissions](https://www.notion.com/help/notion-mcp).

[Apache-2.0](LICENSE)
