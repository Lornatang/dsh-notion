import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { launchChrome } from './chrome-launch.mjs'
import { dismissKnownOnboarding } from './browser-ui.mjs'

export async function verifyBrowser(launchUrl, temp) {
  const chromePath = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((path) => existsSync(path))
  if (!chromePath) {
    if (process.env.CI) throw new Error('Chrome is required in CI; set CHROME_PATH')
    console.log('Chrome unavailable; browser check skipped.')
    return
  }
  const chrome = await launchChrome(chromePath, temp)
  let socket
  try {
    const response = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(15000) })
    assert.equal(response.status, 200)
    const target = await response.json()
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    const pending = new Map()
    let id = 0
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id); clearTimeout(waiter.timer)
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result)
    })
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const next = ++id
      const timer = setTimeout(() => { pending.delete(next); reject(new Error(`browser command timed out: ${method}`)) }, 15000)
      pending.set(next, { resolve, reject, timer }); socket.send(JSON.stringify({ id: next, method, params }))
    })
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text)
      return result.result.value
    }
    await send('Page.enable')
    if (process.env.DSH_TEST_LANGUAGE) {
      const version = await send('Browser.getVersion')
      await send('Network.setUserAgentOverride', { userAgent: version.userAgent, acceptLanguage: process.env.DSH_TEST_LANGUAGE })
    }
    await send('Page.navigate', { url: launchUrl })
    let opened = false
    for (let i = 0; i < 300; i++) {
      const action = await evaluate(`(() => {
        const onboarding = (${dismissKnownOnboarding.toString()})();
        if (onboarding !== 'none') return { kind: onboarding };
        const visible = (node) => { const r = node.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight; };
        const settings = [...document.querySelectorAll('button,[role=button],a,[role=menuitem]')].find((node) => { const label = (node.getAttribute('aria-label') || node.textContent || '').trim(); return visible(node) && (label.startsWith('设置') || label.startsWith('Settings') || label.includes('打开设置')); });
        if (settings) { settings.click(); return { kind: 'opened' }; }
        const account = [...document.querySelectorAll('button')].find((node) => /账号菜单|账户菜单|Account menu/i.test(node.getAttribute('aria-label') || ''));
        if (!account || !visible(account)) { const toggle = [...document.querySelectorAll('button')].find((node) => /打开侧边栏|Open sidebar/i.test(node.getAttribute('aria-label') || '') && visible(node)); if (toggle) toggle.click(); return { kind: 'waiting' }; }
        if (account.getAttribute('aria-expanded') === 'true') return { kind: 'waiting' };
        const r = account.getBoundingClientRect(); return { kind: 'account', x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`)
      if (action.kind === 'opened') { opened = true; break }
      if (action.kind === 'account') {
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: action.x, y: action.y })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: action.x, y: action.y })
      }
      await delay(action.kind === 'account' ? 300 : 100)
    }
    if (!opened) {
      const detail = await evaluate(`(() => ({ buttons: [...document.querySelectorAll('button,[role=button],a,[role=menuitem]')].map(n => ({ text:(n.textContent || '').trim().slice(0,50), aria:n.getAttribute('aria-label'), title:n.getAttribute('title'), expanded:n.getAttribute('aria-expanded') })).filter(v => v.text || v.aria || v.title).slice(-60), dialogs: [...document.querySelectorAll('[role=dialog]')].map(n => ({ text:n.innerText.slice(0,300), hidden:n.getAttribute('aria-hidden') })) }))()`)
      throw new Error(`DSH settings did not open: ${JSON.stringify(detail)}`)
    }
    let selected = false
    for (let i = 0; i < 100; i++) {
      selected = await evaluate(`(() => { const hit = [...document.querySelectorAll('button,[role=button],a,li')].find((node) => (node.textContent || '').trim() === 'Notion'); if (!hit) return false; hit.click(); return true; })()`)
      if (selected) break
      await delay(100)
    }
    assert.ok(selected, 'Notion settings entry did not render')
    let ready = false
    for (let i = 0; i < 100; i++) {
      ready = await evaluate(`!!document.querySelector('[data-dsh-notion-settings] [role=status]') && !!document.querySelector('[data-dsh-notion-settings] a.dsn-button')`)
      if (ready) break
      await delay(100)
    }
    assert.ok(ready, 'Notion authorization UI did not render')
    const panel = await evaluate(`document.querySelector('[data-dsh-notion-settings]').innerText`)
    assert.ok(panel.includes('Waiting for Notion authorization'), 'Notion status must be in English')
    assert.ok(panel.includes('Authorize in Notion'), 'Notion action must be in English')
    assert.doesNotMatch(panel, /[\u3400-\u9fff]/u, 'Notion settings must be in English')
    if (process.env.DSH_TEST_LANGUAGE) {
      const language = await evaluate('navigator.language')
      assert.ok(language.toLowerCase().startsWith(process.env.DSH_TEST_LANGUAGE.toLowerCase()), 'browser language override must apply')
    }
    console.log('Chrome: Notion settings and authorization link rendered.')
  } finally { socket?.close(); await chrome.close() }
}
