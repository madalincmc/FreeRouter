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
const uuid = z.uuid()
const weight = z.number().min(0).max(100)
/** Model picker value: auto, auto:<profile>, chain:<name> or <provider>/<model_id>. */
const pickerValue = z.string().min(1).max(256).regex(/^(auto(:[a-z]+)?|chain:[\w.-]+|[a-z0-9-]+\/.+)$/)

/** Every channel's arguments are validated with Zod before the handler runs. */
export const argSchemas: { [C in IpcChannel]: z.ZodType<IpcContract[C]['args']> } = {
  'app:getInfo': z.tuple([]),
  'gateway:getStatus': z.tuple([]),
  'gateway:setEnabled': z.tuple([z.boolean()]),
  'gateway:setPort': z.tuple([z.number().int().min(1024).max(65535)]),
  'gateway:getToken': z.tuple([]),
  'gateway:regenerateToken': z.tuple([]),
  'gateway:recentRequests': z.tuple([z.number().int().min(1).max(500)]),
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
  'models:usageToday': z.tuple([]),
  'chat:list': z.tuple([]),
  'chat:get': z.tuple([uuid]),
  'chat:create': z.tuple([]),
  'chat:rename': z.tuple([uuid, z.string().max(200)]),
  'chat:delete': z.tuple([uuid]),
  'chat:setOptions': z.tuple([uuid, z.object({ model: pickerValue.optional(), privateMode: z.boolean().optional() }).strict()]),
  'chat:send': z.tuple([uuid, z.string().min(1).max(500_000)]),
  'chat:regenerate': z.union([z.tuple([uuid]), z.tuple([uuid, pickerValue]), z.tuple([uuid, z.undefined()])]),
  'chat:continue': z.tuple([uuid, uuid]),
  'chat:stop': z.tuple([uuid]),
  'chat:modelOptions': z.tuple([]),
  'settings:get': z.tuple([]),
  'settings:update': z.tuple([
    z
      .object({
        routing: z
          .object({
            weights: z
              .object({ quality: weight, reliability: weight, speed: weight, headroom: weight })
              .strict()
              .optional(),
            topN: z.number().int().min(1).max(10).optional(),
            maxPerProvider: z.number().int().min(1).max(10).optional(),
            ttftTimeoutMs: z.number().int().min(2_000).max(120_000).optional(),
            totalTimeoutMs: z.number().int().min(10_000).max(900_000).optional(),
            allowFallbackWhenPinned: z.boolean().optional(),
            minToolsQuality: z.number().int().min(0).max(100).optional(),
            stickiness: z.boolean().optional()
          })
          .strict()
          .optional(),
        privateMode: z.boolean().optional(),
        logRetentionDays: z.number().int().min(1).max(365).optional(),
        launchAtLogin: z.boolean().optional(),
        startMinimized: z.boolean().optional(),
        gatewayAllowedOrigins: z.array(z.string().regex(/^https?:\/\/[^\s/]+$/)).max(20).optional(),
        autoUpdate: z.boolean().optional()
      })
      .strict()
  ]),
  'settings:resetRouting': z.tuple([]),
  'chains:list': z.tuple([]),
  'chains:save': z.tuple([z.string().regex(/^[\w.-]{1,40}$/), z.array(modelId).max(20)]),
  'chains:delete': z.tuple([z.string().max(40)]),
  'updates:getStatus': z.tuple([]),
  'updates:check': z.tuple([]),
  'updates:install': z.tuple([])
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
