import { spawn } from 'node:child_process'

/** Open a browser without invoking a shell. */
export function openInBrowser(value: string): Promise<boolean> {
  let url: URL
  try { url = new URL(value) } catch { return Promise.resolve(false) }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    return Promise.resolve(false)
  }
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url.href] : [url.href]
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    let done = false
    const finish = (result: boolean): void => { if (!done) { done = true; resolve(result) } }
    child.once('error', () => finish(false))
    child.once('spawn', () => { child.unref(); finish(true) })
  })
}
