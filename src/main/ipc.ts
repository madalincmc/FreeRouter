import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { z } from 'zod'
import { redact } from '@core/security/redact'
import type { IpcChannel, IpcContract, IpcEvent, IpcEvents } from '@shared/ipc'

type Handler<C extends IpcChannel> = (
  ...args: IpcContract[C]['args']
) => IpcContract[C]['result'] | Promise<IpcContract[C]['result']>

const id = z.string().min(1).max(64)
const limitValue = z.number().int().min(0).max(1_000_000_000).optional()
const limits = z.object({ rpm: limitValue, rpd: limitValue, tpm: limitValue, tpd: limitValue }).strict()
/** Registry ids are `<provider>/<model_id>`; model ids can contain slashes and colons. */
const modelId = z.string().min(3).max(256)
const qualityValue = z.number().int().min(0).max(100).nullable().optional()

/** Every channel's arguments are validated with Zod before the handler runs. */
export const argSchemas: { [C in IpcChannel]: z.ZodType<IpcContract[C]['args']> } = {
  'app:getInfo': z.tuple([]),
  'gateway:getStatus': z.tuple([]),
  'gateway:setEnabled': z.tuple([z.boolean()]),
  'settings:getTheme': z.tuple([]),
  'settings:setTheme': z.tuple([z.enum(['dark', 'light', 'system'])]),
  'providers:list': z.tuple([]),
  'providers:setEnabled': z.tuple([id, z.boolean()]),
  'providers:setLimitOverrides': z.tuple([id, limits]),
  'keys:add': z.tuple([
    z
      .object({
        providerId: id,
        label: z.string().trim().max(64),
        // Keys are single tokens; anything with whitespace inside is a paste error.
        key: z.string().trim().min(8).max(1024).regex(/^\S+$/)
      })
      .strict()
  ]),
  'keys:test': z.tuple([id]),
  'keys:setEnabled': z.tuple([id, z.boolean()]),
  'keys:delete': z.tuple([id]),
  'models:list': z.tuple([]),
  'models:syncStatus': z.tuple([]),
  'models:sync': z.union([z.tuple([]), z.tuple([id]), z.tuple([z.undefined()])]),
  'models:setEnabled': z.tuple([modelId, z.boolean()]),
  'models:setQuality': z.tuple([
    modelId,
    z
      .object({
        general: qualityValue,
        coding: qualityValue,
        reasoning: qualityValue,
        tools: qualityValue
      })
      .strict()
  ]),
  'models:test': z.tuple([modelId]),
  'models:usageToday': z.tuple([])
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
      throw new Error(redact(err instanceof Error ? err.message : String(err)))
    }
  })
}

export function emit<E extends IpcEvent>(target: WebContents | undefined, event: E, payload: IpcEvents[E]): void {
  if (target && !target.isDestroyed()) target.send(event, payload)
}
