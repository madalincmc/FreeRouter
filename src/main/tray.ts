import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { GatewayStatus, UpdateStatus } from '@shared/ipc'

export interface TrayActions {
  open(): void
  toggleGateway(): void
  quit(): void
  gatewayStatus(): GatewayStatus
  healthyModelCount(): number
  updateStatus(): UpdateStatus
  installUpdate(): void
}

export class AppTray {
  private readonly tray: Tray

  constructor(
    iconPath: string,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(nativeImage.createFromPath(iconPath))
    this.tray.setToolTip('FreeRouter')
    this.tray.on('click', () => actions.open())
    this.refresh()
  }

  refresh(): void {
    const gw = this.actions.gatewayStatus()
    const update = this.actions.updateStatus()
    const updateItems: MenuItemConstructorOptions[] =
      update.state === 'ready'
        ? [{ label: `Restart to update to v${update.availableVersion}`, click: () => this.actions.installUpdate() }]
        : []
    const menu = Menu.buildFromTemplate([
      { label: 'Open FreeRouter', click: () => this.actions.open() },
      ...updateItems,
      { type: 'separator' },
      {
        label: `Gateway (127.0.0.1:${gw.port})`,
        type: 'checkbox',
        checked: gw.enabled,
        click: () => this.actions.toggleGateway()
      },
      { label: `Healthy models: ${this.actions.healthyModelCount()}`, enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => this.actions.quit() }
    ])
    this.tray.setContextMenu(menu)
  }

  destroy(): void {
    this.tray.destroy()
  }
}
