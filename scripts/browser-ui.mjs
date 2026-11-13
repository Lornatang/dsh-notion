/** Dismiss only known DSH onboarding dialogs; leave all other dialogs alone. */
export function dismissKnownOnboarding(doc = document) {
  const visible = (node) => node.getAttribute('aria-hidden') !== 'true' && node.getClientRects().length > 0
  for (const dialog of doc.querySelectorAll('[role=dialog]')) {
    if (!visible(dialog)) continue
    const text = dialog.innerText || ''
    const preview = /\u9884\u89c8\u7248\u8bf4\u660e|Preview Notice/i.test(text)
    const welcome = /\u5f00\u59cb\u4f7f\u7528|Get started/i.test(text)
    if (!preview && !welcome) continue
    const buttons = [...dialog.querySelectorAll('button')].filter((button) => visible(button) && !button.disabled)
    let button
    if (preview) {
      button = buttons.find((item) => /^(\u7ee7\u7eed|Continue)$/i.test((item.textContent || '').trim()))
    } else {
      button = buttons.find((item) => /^(\u5173\u95ed|Close|Dismiss)$/i.test(item.getAttribute('aria-label') || item.getAttribute('title') || ''))
      if (!button) {
        const unnamed = buttons.filter((item) => !(item.textContent || '').trim() && !item.getAttribute('aria-label') && !item.getAttribute('title'))
        if (unnamed.length === 1) button = unnamed[0]
      }
    }
    if (!button) return 'waiting'
    button.click()
    return 'dismissed'
  }
  return 'none'
}
