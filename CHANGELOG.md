# Changelog

## 0.1.9 - 2026-11-19

- Share one loopback-host predicate between the OAuth callback and the browser helper.
- Drop the OAuth provider unused logger option.

## 0.1.8 - 2026-11-18

- Redact access tokens and bound their length before a connection error reaches the settings panel, and keep the rest of the dialog usable.
- Answer malformed request targets with 400 and unexpected failures with a generic 500 instead of letting the request hang or leak internals.
- Validate the encryption key as standard Base64 for exactly 32 bytes, and treat keyring deletion as best-effort so disconnect cannot fail on a missing entry.
- Retry a failed MCP client initialization once instead of leaving the bridge unavailable until reconnect.
- Reject invalid server names and MCP URLs at construction instead of failing later at the store or SDK boundary.
- Reject `toolCallTimeoutMs` values above the 32-bit signed millisecond limit.
- Fall back to a bounded message when a validation worker fails without an error string, and fsync the session directory after replacing the credential file.

## 0.1.7 - 2026-11-17

- Reuse a bounded pool of validation workers instead of spawning one per tool call; warm structured-output validation drops from ~33 ms to ~0.04 ms. Compiled schemas are cached per worker with fresh validator instances so schemas sharing an `$id` stay isolated.
- Count SSE comment (keepalive) lines as events so comment floods can no longer bypass the byte and rate limits, and skip ordinary byte runs with native scans while preserving exact per-event accounting.
- Replace fixed-interval status polling with event-driven waits in the bridge; the settings panel polls adaptively, pauses while hidden, and times out hung API requests.
- Harden the OAuth callback server with connection and timeout bounds and compare callback state in constant time.
- Survive throwing tool-dispose hooks during connection cleanup without unhandled rejections, and report the real package version in the MCP client identity.

## 0.1.6 - 2026-11-15

- Retry a failed OAuth callback bind when connecting again after the port becomes available.
- Keep long-lived event streams open beyond the tool-call timeout and report terminal reconnection failures.
- Include a GitHub release archive; npm is not published for this release.

## 0.1.5 - 2026-11-15

- Rewrite the README to the package-bundle documentation convention and add a
  Chinese translation; the package now ships `README.md` and `README.zh.md`.
- Publish `cordis.patch.yml` through the package `exports` map and include the
  Chinese README in the published files.

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
