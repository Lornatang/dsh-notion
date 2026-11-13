# Changelog

## 0.1.4

- Allow any DSH version in the package metadata and run integration checks against the selected host.
- Make the slow-tool timeout test use a controlled response instead of a short timing race.

## 0.1.3

- Bound tool discovery, server-initiated requests, stream events, and rapid reconnects.
- Cancel stalled connection requests promptly and preserve credentials when the callback port is occupied.
- Protect credential paths against directory substitution and hard links; reject asynchronous output schemas that cannot be validated safely.

## 0.1.2

- Show the Notion settings interface in English regardless of browser language.
- Keep the README focused on installation and everyday use.

## 0.1.1

- Serialize authorization and recover from broken connections and host service changes.
- Fence stale OAuth writes after disconnect and bound remote response sizes.
- Isolate structured-output validation and add lifecycle and security regression tests.
- Document Desktop, Web, npm installation, permissions, troubleshooting, and uninstall.

## 0.1.0

- Connect DeepSeek Harness to Notion MCP using OAuth with PKCE.
- Register Notion tools and expose MCP resources to agent sessions.
- Add a connection settings page for DSH Web.
