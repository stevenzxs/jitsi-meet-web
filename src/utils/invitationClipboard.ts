/** Copy invitation text without reporting success when the legacy fallback fails. */
export async function copyInvitationText(
  text: string,
  environment: { clipboard?: Pick<Clipboard, 'writeText'>; document: Document } = {
    clipboard: navigator.clipboard,
    document,
  },
): Promise<void> {
  try {
    if (!environment.clipboard) throw new Error('Clipboard unavailable')
    await environment.clipboard.writeText(text)
    return
  } catch {
    const doc = environment.document
    const previousFocus = doc.activeElement as HTMLElement | null
    const textarea = doc.createElement('textarea')
    textarea.value = text
    textarea.setAttribute('readonly', '')
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    // Native modal dialogs make the rest of the document inert.
    const container = doc.querySelector?.('dialog[open]') ?? doc.body
    container.appendChild(textarea)
    try {
      textarea.select()
      if (!doc.execCommand('copy')) throw new Error('Invitation copy failed')
    } finally {
      textarea.remove()
      previousFocus?.focus()
    }
  }
}
