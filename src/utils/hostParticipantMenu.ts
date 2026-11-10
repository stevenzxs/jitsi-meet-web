type HostAction = 'transfer' | 'reclaim' | null

/** Unknown roles, local targets and guests fail closed. */
export function getHostParticipantAction(
  canTransfer: boolean, canReclaim: boolean, targetRole: string, localTarget: boolean,
): HostAction {
  if (localTarget) return null
  if (canReclaim && targetRole === 'moderator') return 'reclaim'
  if (canTransfer && (targetRole === 'participant' || targetRole === 'none')) return 'transfer'
  return null
}

export const HOST_RECLAIM_MENU_ID = 'cloudmeet-reclaim-host'
const TRANSFER_ID = 'cloudmeet-transfer-host'

/** Update the existing custom participant action before the pane opens its menu.
 * Never changes participant roles or grants native moderator controls. */
export function attachHostParticipantMenu(frame: Window, read: (id: string) => HostAction): () => void {
  const app = (frame as Window & { APP?: any }).APP
  const store = app?.store
  if (!store?.subscribe || !store?.dispatch) return () => {}
  const doc = frame.document
  let target = ''
  let updating = false
  const original = store.getState()['features/base/config'].customParticipantMenuButtons ?? []
  const template = original.find((item: { id: string }) => item.id === TRANSFER_ID)
  const sync = () => {
    if (updating) return
    const action = target ? read(target) : null
    const config = store.getState()['features/base/config']
    const others = (config.customParticipantMenuButtons ?? []).filter(
      (item: { id: string }) => item.id !== TRANSFER_ID && item.id !== HOST_RECLAIM_MENU_ID)
    const buttons = action ? [...others, {
      ...template,
      id: action === 'reclaim' ? HOST_RECLAIM_MENU_ID : TRANSFER_ID,
      text: action === 'reclaim' ? '收回主持人' : '设置主持人',
    }] : others
    if (JSON.stringify(config.customParticipantMenuButtons ?? []) === JSON.stringify(buttons)) return
    updating = true
    try { store.dispatch({ type: 'SET_CONFIG', config: { ...config, customParticipantMenuButtons: buttons } }) }
    finally { updating = false }
  }
  const select = (event: Event) => {
    const element = event.target as Element | null
    const button = element?.closest?.('[data-testid^="participant-more-options-"]')
    if (!button) return
    target = button.getAttribute('data-testid')!.slice('participant-more-options-'.length)
    sync()
  }
  doc.addEventListener('pointerdown', select, true)
  doc.addEventListener('click', select, true)
  doc.addEventListener('keydown', select, true)
  const unsubscribe = store.subscribe(sync)
  sync()
  return () => {
    unsubscribe()
    doc.removeEventListener('pointerdown', select, true)
    doc.removeEventListener('click', select, true)
    doc.removeEventListener('keydown', select, true)
  }
}
