---
description: "Notion's official MCP server inside a dsh profile: the OAuth connection, the encrypted grant it stores, and every tool the server advertises."
kind: "package-bundle"
---

# @lornatang/dsh-notion

English | [中文](README.zh.md)

## Summary

`dsh-notion` connects a dsh profile to Notion's official MCP server. It runs the OAuth flow, keeps the grant in an encrypted file in the profile with its key in the host credential store, and registers every tool the server advertises so an agent can search, read, and update workspace content as the authorizing account. Add it with the `add` command, authorize once in Settings → Notion, and remove it the same way. The boundary: one Notion connection per row, credentials tied to the profile path and the host keyring, no tool text of its own.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The layer owns the connection and nothing else: the MCP server decides which tools exist and what their schemas are, the Notion account decides what they may change, and the profile's own tool permissions still apply to every call. Install it into the Web profile whose sessions should reach Notion.

### Install into a profile

```text
dsh plugin --profile <name> add @lornatang/dsh-notion
dsh plugin --profile <name> remove @lornatang/dsh-notion
```

For the GitHub 0.1.11 release, use `dsh plugin --profile <name> add https://github.com/Lornatang/dsh-notion/releases/download/v0.1.11/lornatang-dsh-notion-0.1.11.tgz`.

The `add` command composes the bundle into the profile: its `cordis.patch.yml` gains an insert entry, row id `notion`, whose `config` starts from `serverName: notion`, `url: https://mcp.notion.com/mcp`, `redirectPort: 3335` and `autoOpenBrowser: false`. The row leaves `toolCallTimeoutMs` and `authorizationTimeoutMs` out, so those two fields take the schema defaults of 60000 ms and 300000 ms. `package.json` declares this file through `dsh.bundle.patch`, and the same manifest declares the client entry that renders the settings page.

Restart DSH after `add` or `remove`: the row is composed when the profile loads, and the bridge starts with it. In a Web profile, open Settings → Notion; the page reports the connection state and drives the same bridge that registers the tools.

On a fresh profile no credential file exists yet, so the bridge binds `http://127.0.0.1:<redirectPort>/callback`, connects to the MCP endpoint, and is answered with an authorization challenge. The page then shows Waiting for Notion authorization with an Authorize in Notion link; startup never opens a browser itself, and `autoOpenBrowser` only affects the Connect action. Approve the connection in Notion; the callback delivers the code, the grant is written to the encrypted file, the server's tools are registered, and the page shows Connected with the tool count. If the browser does not return within `authorizationTimeoutMs` (five minutes by default), the attempt ends at Connection failed and Connect Notion starts a new one.

### What you get

| Surface | Provided by |
|---|---|
| `mcp__notion__<tool>` for every tool Notion advertises | host entry, `src/bridge.ts` |
| `mcp__notion__dsh_list_resources`, `mcp__notion__dsh_list_resource_templates` and `mcp__notion__dsh_read_resource`, when the server advertises resources | host entry, `src/bridge.ts` |
| Settings → Notion page | client entry, `src/client/index.tsx`, slot `settings.section`, order 31 |
| `GET /plugins/notion/status`, `POST /plugins/notion/connect` and `POST /plugins/notion/disconnect` | host entry, `src/routes.ts` |
| `<profile>/data/dsh-notion-<serverName>-<hash>.json` | host entry, `src/store.ts` |

Every registered tool is named `mcp__notion__<name>`. Characters outside letters, digits, hyphen and underscore become underscores, and a name that had to be rewritten or is longer than 64 characters becomes its first 51 characters, an underscore and a 12-character digest of the server and tool names. Descriptions and input schemas are the server's, so the tool list changes when the server changes it. Tool results are the server's content array: text blocks are joined with blank lines and every other block type appears as `[type content]`. A tool that returns an error throws; a tool that advertises an output schema must return `structuredContent`, which is validated before the result is rendered.

When the server advertises the resources capability, three resource tools join the same prefix: `dsh_list_resources` and `dsh_list_resource_templates` take an optional continuation cursor, and `dsh_read_resource` requires an exact URI. Their results are serialized as JSON text; resource bytes are not turned into native media.

The settings page renders the header Notion with the subtitle Connect your Notion workspace to DSH, a Connection label, a status card with a state dot and one of Loading, Not connected, Connecting, Waiting for Notion authorization, Connected or Connection failed plus the number of tools available, a note that switches to the authorization reminder while authorizing, an error alert when the bridge reports one, and the actions Authorize in Notion (a link to the authorization URL while authorizing), Connect Notion, Disconnect, Refresh status, and the help link Learn about Notion MCP permissions and administration. It polls `GET /plugins/notion/status` every three seconds and stays in English on every browser locale.

The three routes sit behind the DSH connection fence: while the connection service is absent they answer 503, and a fenced request is rejected with the fence's own status. Connect and Disconnect return the same status snapshot the settings page renders.

### Credentials

OAuth tokens, the registered client information and the PKCE verifier are stored together in one file, `<profile>/data/dsh-notion-<serverName>-<first 12 hex of sha256(url)>.json`, as an AES-256-GCM envelope (`version` 1, algorithm `aes-256-gcm`, IV, tag and ciphertext) with the file path as additional authenticated data. Changing `serverName` or `url` selects a different file.

The 32-byte key comes from `DSH_NOTION_ENCRYPTION_KEY` (standard Base64 of exactly 32 bytes) or, when that variable is unset, from the operating-system credential store through `@napi-rs/keyring`: macOS Keychain, Windows Credential Manager, or the Linux Secret Service. The keyring entry uses service `dsh-notion` and the SHA-256 of the file path as its account. There is no plaintext fallback: when no key can be read or created, the connection fails with `notion: secure key storage is unavailable; unlock the system keychain or set DSH_NOTION_ENCRYPTION_KEY to a persistent base64-encoded 32-byte key`.

On POSIX the data directory is created `0700` and checked for a foreign owner and for group or world write access, the file is `0600`, opened with `O_NOFOLLOW`, required to be a regular file with a single hard link, and replaced atomically. Windows skips the mode and ownership checks, so restrict the profile directory with ACLs. Run one DSH process per profile: nothing in the package coordinates a second writer.

For a headless or container host, set `DSH_NOTION_ENCRYPTION_KEY` to a persistent secret before DSH starts, for example from `openssl rand -base64 32`, and keep the same value and profile path across restarts. Changing either makes the existing file unreadable; restore the original, or stop DSH, remove that file and connect again. Disconnect deletes the encrypted file, removes the keyring entry when the keyring was used, and unregisters the tools; it does not revoke the grant, which stays listed in the Notion account settings.

### Configuration

The bundle ships the row below, so a profile only lists what differs from it. The loader validates each field against `src/config.ts` and rejects an invalid value at startup instead of substituting a default.

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- id: notion
  config:
    serverName: notion
    url: 'https://mcp.notion.com/mcp'
    redirectPort: 3335
    autoOpenBrowser: false
```

A bare `notion` row without `config` runs on these defaults:

| Field | Default | Meaning |
|---|---|---|
| `serverName` | `notion` | Tool prefix and credential identity; 1–64 letters, digits, hyphens or underscores. |
| `url` | `https://mcp.notion.com/mcp` | MCP endpoint; HTTPS is required unless the host is a loopback address. |
| `redirectPort` | `3335` | Loopback OAuth callback port, 0–65535; `0` picks a free port. |
| `toolCallTimeoutMs` | `60000` | Deadline for connecting, tool discovery, tool and resource calls, and every transport request; at least 1 ms, with no upper bound. |
| `authorizationTimeoutMs` | `300000` | Time allowed for the browser to return the authorization code; at least 1000 ms. |
| `autoOpenBrowser` | `false` | Opens the authorization URL on the DSH host when Connect Notion is selected, not during startup. |

The callback URL is part of the saved grant. Changing `redirectPort`, or leaving the ephemeral port `0` to pick a different port, discards the stored client registration, tokens and PKCE verifier, so the next start needs a new authorization. The MCP endpoint and every OAuth endpoint must share one origin; a request that leaves that origin is rejected, and plain HTTP is accepted only for a loopback server.

### Troubleshooting

- **Secure key storage is unavailable** — unlock the operating-system keychain, check the Linux Secret Service and its D-Bus session, or set `DSH_NOTION_ENCRYPTION_KEY`.
- **Stored credentials cannot be decrypted** — restore the original key and profile path, or stop DSH, remove the credential file and connect again.
- **Authorization does not return** — check that `redirectPort` is free on the DSH host and forwarded when DSH runs on a remote machine; after a timeout select Connect Notion.
- **Tools are missing or a call is denied** — check Notion MCP availability, the workspace administrator policy, the account's Notion permissions, and the DSH log.
- **The connection fails after a network interruption** — select Connect Notion; a grant that is still valid is reused.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The bundle has two halves declared in `package.json`: the host entry, mounted by the row that `dsh.bundle.patch` names, and the client entry exported as `./client`, which `dsh.client.inject` wires to the UI slots and settings packages under `platform: web`. The host module registers as `notion`, injects the `tools` service, and the client module injects `slots`.

`apply` builds the credential store from `serverName`, `url` and the profile patch path the host reports, constructs the bridge, registers a dispose effect, and binds the `/plugins/notion` routes when a web server (or HTTP server) and the connection service exist, rebinding when those services are replaced. It then starts the bridge: load the store, bind the loopback callback listener, drop the saved client registration, tokens and PKCE verifier when the callback URL changed, patch the new callback URL into the store, and connect. A 401 response runs the SDK authorization flow, which publishes the authorization URL; the bridge waits for the loopback callback for at most `authorizationTimeoutMs`, exchanges the code, and retries the connection. The successful connection registers the tools and reports `ready`; a second failure reports `error` with the message the page shows.

Every transport request goes through a fetch wrapper that requires HTTPS (loopback HTTP allowed), keeps the target origin equal to the configured server origin, enforces `toolCallTimeoutMs` on each request, caps decoded responses at 16 MiB, and limits stream events to 1000 per ten seconds and server-opened event streams to 8 per ten seconds. Tool discovery walks cursor pages under an 8 MiB and 1000-tool budget, rejects duplicate names, and registers one definition per tool whose execute calls the server tool, throws on an error result, and requires and validates `structuredContent` when the tool declares an output schema, with JSON Schema validation isolated in a worker thread.

The callback listener binds only `127.0.0.1`. Client UI text is fixed English, and the settings page is one `settings.section` row. Disconnect aborts the connection, closes the client, unregisters the tools and destroys the stored grant; unloading the profile disposes the bridge and keeps the grant for the next start.

| Source | Contents |
|---|---|
| `cordis.patch.yml` | The layer: one insert entry, row id `notion`, server defaults. |
| `src/index.ts` | `apply`: store and bridge construction, effect registration, route binding, startup. |
| `src/config.ts` | The six configuration fields, their schema ranges and defaults. |
| `src/bridge.ts` | Connection lifecycle, authorization wait, tool registration and naming, transport limits, status snapshot. |
| `src/oauth.ts` | Same-origin fetch guard, loopback callback server, OAuth provider with PKCE, state and client metadata. |
| `src/store.ts` | Credential file path, AES-256-GCM envelope, keyring or environment key, file hardening. |
| `src/routes.ts` | The `/plugins/notion` status, connect and disconnect routes, fence and 503 handling. |
| `src/response-limit.ts` | The 16 MiB decoded response cap and per-event stream cap. |
| `src/output-validator.ts`, `src/output-validator-worker.ts` | Deferred, worker-isolated JSON Schema validation of structured tool output. |
| `src/open-url.ts` | Opening the authorization URL on the host, HTTPS or loopback HTTP only. |
| `src/client/index.tsx` | The Settings → Notion section: slot registration, status polling, actions. |
| `tests/*.test.mjs` | Bridge, entry, language and security suites against a mock MCP server. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [CHANGELOG.md](CHANGELOG.md) — release history from 0.1.0 to 0.1.4.
- [scripts/verify-dsh.mjs](scripts/verify-dsh.mjs) — end-to-end check that installs the packed bundle into a temporary profile, serves a mock MCP endpoint with OAuth, drives the Web UI through Chrome and asserts that the stored credentials are encrypted.
- [Notion MCP permissions and administration](https://www.notion.com/help/notion-mcp) — what the consent screen grants and how workspace administrators control it.
- [DeepSeek Harness configuration catalog](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/config-catalog.md) — the loader semantics this layer's row obeys.
- [NOTICE](NOTICE) — portions adapted from dsh-atlassian-bridge.
- [Apache-2.0 license](LICENSE).

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the tools the Notion server advertises: each registered tool contributes its name, description and JSON input schema to the tool definitions the model can call, and tool results return as text.

#### KV Cache effect

Tool definitions belong to the request prefix, so connecting adds the schemas of every registered Notion tool and disconnecting removes them; while the tool set is unchanged the prefix is stable and the cached tokens before it are reusable. A reconnect that discovers a different tool list, or a `serverName` change that moves the `mcp__notion__` prefix, changes that prefix from the first affected definition onward and invalidates cached tokens after it.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

These limits tell you when the layer does not fit and what it needs from the profile around it.

- **One connection per row** — the credential file is keyed by `serverName` and the URL digest, so a second connection needs a second row with its own `serverName`; two rows that share both values share one grant.
- **The callback port must be free at startup** — the listener binds `127.0.0.1:<redirectPort>` before connecting, and a taken port leaves the row at Connection failed; the page's Connect action retries the listener, and if the port stays occupied recovery takes a DSH restart.
- **The callback URL must stay stable** — a different effective port, from a changed `redirectPort` or from `0` picking another one, makes the saved redirect URI stale, so the client registration, tokens and PKCE verifier are discarded and a new authorization is required.
- **Authorization times out after five minutes** — `authorizationTimeoutMs` defaults to 300000 ms; when the browser does not return in that window the attempt ends at Connection failed and Connect Notion starts a new one.
- **Credentials are bound to the profile path and key** — the file path is authenticated data and the keyring entry is keyed by that path's digest, so moving the profile or changing `DSH_NOTION_ENCRYPTION_KEY` makes the file unreadable, and there is no plaintext fallback.
- **Headless hosts need their own key** — without an unlocked operating-system credential store (on Linux, the Secret Service) every connection fails until `DSH_NOTION_ENCRYPTION_KEY` holds a persistent Base64 32-byte key; on Windows the mode and ownership checks are skipped, so the profile directory needs ACLs.
- **Disconnect is local only** — it removes the encrypted file, the keyring entry and the registered tools, but the grant stays in the Notion account until it is revoked in Notion's connection settings.
- **Each tool call carries the tool timeout** — `toolCallTimeoutMs` (60 seconds by default) bounds tool calls and discovery requests, but not a server-opened GET event stream, which stays open until the connection is closed; more than eight such opens in ten seconds makes the bridge drop to Connection failed.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

`npm run build` runs `clean`, compiles the host project into `lib` and `lib/types`, compiles the client project into `lib/client-build` and `lib/types/client`, then runs `scripts/bundle-client.mjs`, which wraps the compiled client into `lib/client.js` as a `window.__ModuleLoader__` bundle. `lib` is committed and CI runs `git diff --exit-code -- lib`, so rebuild and commit it with any source change. `npm run typecheck` checks both projects without emitting. `npm test` builds first and then runs `node --test tests/*.test.mjs`; `npm run test:dsh` runs `scripts/verify-dsh.mjs` and needs a real DSH binary (`DSH_TEST_BINARY`), Chrome (`CHROME_PATH`) and network-free mock MCP endpoints, which is why it is a separate Linux CI job; on Windows the DSH launcher is `dsh.cmd` and the script spawns it without a shell, so it is not run there. `prepack` runs the test suite.

Node.js 22.19 or newer is required by `engines`; the only peer dependency is `@deepseek-ai/cordis ~4.1.0`. The credential file format is a version 1 AES-256-GCM envelope whose AAD is the file path and whose key lives in the OS credential store or in `DSH_NOTION_ENCRYPTION_KEY`, so a format change needs an upgrade path before the version is bumped. The settings page strings are asserted English by `tests/language.test.mjs`.

</details>
