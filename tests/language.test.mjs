import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'

test('Notion settings use English for all connection states regardless of browser language', async () => {
  const bundle = await readFile('lib/client.js', 'utf8')
  const states = [
    { status: 'idle', expected: ['Not connected', 'Connect Notion'] },
    { status: 'connecting', expected: ['Connecting', 'Connect Notion'] },
    { status: 'authorizing', expected: ['Waiting for Notion authorization', 'Authorize in Notion'] },
    { status: 'ready', expected: ['Connected', 'Disconnect'] },
    { status: 'error', expected: ['Connection failed', 'Connect Notion'] },
  ]
  for (const language of ['en-US', 'zh-CN', 'fr-FR']) {
    for (const { status, expected } of states) {
      let component
      const snapshot = { ok: true, status, toolCount: 3, authorizationUrl: 'https://example.com/authorize' }
      let index = 0
      const react = {
        createElement: (type, props, ...children) => ({ type, props, children }),
        useState: () => [index++ === 0 ? snapshot : index === 2 ? '' : false, () => {}],
        useCallback: (callback) => callback,
        useEffect: () => {},
      }
      const window = { __ModuleLoader__: { load: ({ factory }) => { component = factory(() => react).NotionSettings } } }
      runInNewContext(bundle, { window, navigator: { language } })
      const text = (value) => typeof value === 'string' ? value : value?.children?.map(text).join(' ') ?? ''
      const rendered = text(component())
      for (const label of expected) assert.ok(rendered.includes(label), `${language} ${status}: missing ${label}`)
      assert.doesNotMatch(rendered, /[\u3400-\u9fff]/u, `${language} ${status}`)
    }
  }
})
