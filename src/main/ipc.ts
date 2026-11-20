import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { redactError } from '@core/security/redact'
import type { IpcChannel, IpcContract, IpcEvent, IpcEvents } from '@shared/ipc'

type Handler<C extends IpcChannel> = (
  ...args: IpcContract[C]['args']
) => IpcContract[C]['result'] | Promise<IpcContract[C]['result']>

/** Every channel's arguments are validated with Zod before the handler runs. */
export const argSchemas: { [C in IpcChannel]: z.ZodType<IpcContract[C]['args']> } = {
  'app:getInfo': z.tuple([]),
  'gateway:getStatus': z.tuple([]),
  'gateway:setEnabled': z.tuple([z.boolean()]),
  'settings:getTheme': z.tuple([]),
  'settings:setTheme': z.tuple([z.enum(['dark', 'light', 'system'])])
}

export function handle<C extends IpcChannel>(
  channel: C,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
  handler: Handler<C>
): void {
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    if (!isTrustedSender(event)) throw new Error('Untrusted IPC sender')
    const parsed = argSchemas[channel].safeParse(rawArgs)
    if (!parsed.success) throw new Error(`Invalid arguments for ${channel}`)
    try {
      return await handler(...parsed.data)
    } catch (err) {
      // Errors crossing the boundary are always redacted.
      throw new Error(redactError(err))
    }
  })
}

export function emit<E extends IpcEvent>(target: WebContents | undefined, event: E, payload: IpcEvents[E]): void {
  if (target && !target.isDestroyed()) target.send(event, payload)
}
