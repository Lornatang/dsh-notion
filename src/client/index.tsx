import * as React from 'react'

const h = React.createElement
const prefix = '/plugins/notion'
interface ClientContext { slots: { inject(name: string, callback: () => unknown): () => void; register(options: Record<string, unknown>, component: React.ComponentType<never>): unknown } }
interface Snapshot { ok: boolean; status: 'idle' | 'connecting' | 'authorizing' | 'ready' | 'error'; error?: string; authorizationUrl?: string; toolCount: number }

if (typeof document !== 'undefined' && !document.querySelector('style[data-dsh-notion]')) {
  const style = document.createElement('style')
  style.setAttribute('data-dsh-notion', '')
  style.textContent = `
.dsn-root{box-sizing:border-box;max-width:820px;margin:auto;padding:24px 28px 36px;font-size:14px;line-height:1.55;color:inherit}
.dsn-root *{box-sizing:border-box}.dsn-root h2,.dsn-root h3,.dsn-root p{margin:0}.dsn-head{display:flex;align-items:center;gap:14px;margin-bottom:24px}
.dsn-logo{display:grid;place-items:center;width:46px;height:46px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:12px;font:700 25px Georgia,serif;background:color-mix(in srgb,currentColor 4%,transparent)}
.dsn-title{font-size:23px;font-weight:700}.dsn-sub{opacity:.68;font-size:13px;margin-top:3px!important}.dsn-label{font-size:11px;letter-spacing:.09em;text-transform:uppercase;opacity:.6;margin-bottom:9px!important;font-weight:700}
.dsn-card{border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:13px;background:color-mix(in srgb,currentColor 2.5%,transparent);padding:18px}
.dsn-status{display:flex;align-items:center;gap:12px}.dsn-dot{width:10px;height:10px;border-radius:50%;background:#e6a23c;flex:none}.dsn-dot.ready{background:#2dbb87}.dsn-dot.error{background:#e15c5c}
.dsn-status-copy{flex:1;min-width:0}.dsn-status-copy strong{display:block}.dsn-count{font-size:12px;opacity:.65;white-space:nowrap}.dsn-note{font-size:13px;opacity:.7;margin-top:14px!important}
.dsn-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:18px}.dsn-button{display:inline-flex;align-items:center;justify-content:center;min-height:36px;padding:7px 14px;border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:9px;background:color-mix(in srgb,currentColor 5%,transparent);color:inherit;font:600 13px inherit;text-decoration:none;cursor:pointer}
.dsn-button.primary{background:#4779ed;color:white;border-color:#4779ed}.dsn-button:disabled{opacity:.45;cursor:not-allowed}.dsn-button:focus-visible{outline:2px solid #7196ff;outline-offset:2px}.dsn-error{margin-top:14px!important;padding:10px 12px;border-radius:9px;background:rgba(230,89,89,.1);color:#e56b6b;overflow-wrap:anywhere}
.dsn-help{margin-top:18px!important;font-size:12px;opacity:.65}.dsn-help a{color:inherit}.dsn-root svg{display:block}@media(max-width:640px){.dsn-root{padding:18px 16px 28px}.dsn-count{white-space:normal;text-align:right}}
`
  document.head.appendChild(style)
}

const text = {
  subtitle: 'Connect your Notion workspace to DSH', label: 'Connection', loading: 'Loading', idle: 'Not connected', connecting: 'Connecting', authorizing: 'Waiting for Notion authorization', ready: 'Connected', error: 'Connection failed',
  tools: 'tools available', note: 'Agents can read and modify workspace content using your permissions. Authorization may also cover member information and connected apps; review the Notion consent screen.', connect: 'Connect Notion', continue: 'Authorize in Notion', disconnect: 'Disconnect',
  auth: 'Complete authorization in your browser, then return to this page.', help: 'Learn about Notion MCP permissions and administration', refresh: 'Refresh status',
}

async function api(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Snapshot> {
  const response = await fetch(prefix + path, { method, cache: 'no-store' })
  const value = await response.json() as Snapshot
  if (!response.ok || !value.ok) throw new Error(value.error || `HTTP ${String(response.status)}`)
  return value
}

export function NotionSettings(): React.ReactElement {
  const [snapshot, setSnapshot] = React.useState<Snapshot>()
  const [error, setError] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const refresh = React.useCallback(async () => {
    try { setSnapshot(await api('/status')); setError('') }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [])
  React.useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh() }, 3000); return () => window.clearInterval(timer) }, [refresh])
  const act = async (action: 'connect' | 'disconnect'): Promise<void> => {
    setBusy(true); setError('')
    try { setSnapshot(await api(`/${action}`, 'POST')) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const status = snapshot?.status ?? 'loading'
  const labels = { loading: text.loading, idle: text.idle, connecting: text.connecting, authorizing: text.authorizing, ready: text.ready, error: text.error }
  return h('div', { className: 'dsn-root', 'data-dsh-notion-settings': '' },
    h('header', { className: 'dsn-head' }, h('div', { className: 'dsn-logo', 'aria-hidden': true }, 'N'),
      h('div', null, h('h2', { className: 'dsn-title' }, 'Notion'), h('p', { className: 'dsn-sub' }, text.subtitle))),
    h('p', { className: 'dsn-label' }, text.label),
    h('section', { className: 'dsn-card' },
      h('div', { className: 'dsn-status', role: 'status', 'aria-live': 'polite' }, h('span', { className: `dsn-dot ${status}` }),
        h('div', { className: 'dsn-status-copy' }, h('strong', null, labels[status])),
        h('span', { className: 'dsn-count' }, `${String(snapshot?.toolCount ?? 0)} ${text.tools}`)),
      h('p', { className: 'dsn-note' }, status === 'authorizing' ? text.auth : text.note),
      error || snapshot?.error ? h('p', { className: 'dsn-error', role: 'alert' }, error || snapshot?.error) : null,
      h('div', { className: 'dsn-actions' },
        snapshot?.authorizationUrl && status === 'authorizing' ? h('a', { className: 'dsn-button primary', href: snapshot.authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, text.continue) : null,
        status !== 'ready' && status !== 'authorizing' ? h('button', { className: 'dsn-button primary', disabled: busy || status === 'connecting', onClick: () => { void act('connect') } }, text.connect) : null,
        status !== 'idle' && status !== 'loading' ? h('button', { className: 'dsn-button', disabled: busy, onClick: () => { void act('disconnect') } }, text.disconnect) : null,
        h('button', { className: 'dsn-button', disabled: busy, onClick: () => { void refresh() } }, text.refresh))),
    h('p', { className: 'dsn-help' }, h('a', { href: 'https://www.notion.com/help/notion-mcp', target: '_blank', rel: 'noopener noreferrer' }, text.help)))
}

export const name = '@lornatang/dsh-notion'
export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'notion', order: 31, label: 'Notion' }, NotionSettings as React.ComponentType<never>))
}
