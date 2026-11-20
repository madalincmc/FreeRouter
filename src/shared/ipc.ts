/**
 * The typed IPC contract between renderer and main (PRD §7: narrow, typed, no keys).
 * Add a channel here first; main and preload are type-checked against this map.
 */

export interface AppInfo {
  name: string
  version: string
  electron: string
  platform: string
  dataDir: string
  schemaVersion: number
  encryptionAvailable: boolean
}

export interface GatewayStatus {
  enabled: boolean
  port: number
  running: boolean
  /** Why it isn't running (e.g. port in use). */
  error: string | null
  baseUrl: string
}

/** One gateway request as shown in the live log (metadata only). */
export interface GatewayRequestView {
  id: number
  ts: number
  client: string | null
  requestedModel: string
  chosenModel: string | null
  status: string
  latencyMs: number | null
  ttftMs: number | null
  attempts: number
  error: string | null
}

export type ThemePreference = 'dark' | 'light' | 'system'

// ---- Providers & keys ----------------------------------------------------

export interface Limits {
  rpm?: number
  rpd?: number
  tpm?: number
  tpd?: number
}

export type LimitScope = 'account' | 'organization' | 'project' | 'key'

export type KeyStatus = 'valid' | 'invalid' | 'untested'

/** A key as the renderer may see it: masked, never plaintext or ciphertext. */
export interface KeyView {
  id: string
  providerId: string
  label: string
  masked: string
  status: KeyStatus
  enabled: boolean
  createdAt: number
  lastOkAt: number | null
}

export interface KeyTestResult {
  outcome: 'valid' | 'invalid' | 'error'
  httpStatus?: number
  message: string
  latencyMs: number
}

export type AddKeyResult =
  | { saved: true; key: KeyView; test: KeyTestResult }
  | { saved: false; reason: 'invalid' | 'duplicate'; test?: KeyTestResult; message: string }

export interface AddKeyInput {
  providerId: string
  label: string
  key: string
}

export interface ProviderView {
  id: string
  name: string
  baseUrl: string
  keyUrl: string
  docsUrl: string
  keyPrefix?: string
  enabled: boolean
  mayTrainOnData: boolean
  limitScope: LimitScope
  keyRotation: boolean
  notes: string
  defaultLimits: Limits
  limitOverrides: Limits
  keys: KeyView[]
}

// ---- Model registry ------------------------------------------------------

export type CapabilityTag = 'coding' | 'reasoning' | 'tools' | 'vision' | 'long_context' | 'fast'
export type QualityProfile = 'general' | 'coding' | 'reasoning' | 'tools'
export type Quality = Partial<Record<QualityProfile, number>>
export type ModelState = 'healthy' | 'degraded' | 'cooling_down' | 'quota_exhausted' | 'gone'

export interface ModelView {
  /** `<provider>/<model_id>` */
  id: string
  providerId: string
  modelId: string
  displayName: string
  isFree: boolean
  isNew: boolean
  enabled: boolean
  tags: CapabilityTag[]
  /** Effective scores (seed/heuristic merged with user overrides). */
  quality: Quality
  /** Which profiles the user has overridden. */
  qualityOverridden: QualityProfile[]
  contextWindow: number | null
  maxOutput: number | null
  /** From the provider's list where available (OpenRouter); empty means unknown. */
  supportedParameters: string[]
  inputModalities: string[]
  state: ModelState
  cooldownUntil: number | null
  lastError: string | null
  p50LatencyMs: number | null
  lastTestedAt: number | null
  firstSeen: number
  lastSeen: number
}

export interface ProviderSyncStatus {
  providerId: string
  lastAttemptAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  modelCount: number
  freeCount: number
}

export interface SyncResult {
  providerId: string
  outcome: 'ok' | 'skipped' | 'error'
  message: string
  added: number
  gone: number
  total: number
}

export interface ModelTestResult {
  ok: boolean
  latencyMs: number
  httpStatus?: number
  message: string
  model: ModelView
}

// ---- Chat ----------------------------------------------------------------

export interface ConversationSummary {
  id: string
  title: string
  /** Picker value: 'auto', 'auto:coding', 'chain:<name>' or '<provider>/<model_id>'. */
  model: string
  privateMode: boolean
  createdAt: number
  updatedAt: number
}

export interface AttemptView {
  provider: string
  model: string
  outcome: 'ok' | 'failed' | 'skipped' | 'mid_stream_error'
  failure?: string
  status?: number
  message?: string
  ms: number
}

export interface MessageMeta {
  provider?: string
  model?: string
  /** What the user asked for when this reply was generated. */
  requested?: string
  attempts?: AttemptView[]
  ttftMs?: number
  latencyMs?: number
  usage?: { prompt_tokens: number; completion_tokens: number; estimated: boolean }
  reasoning?: string
  error?: string
  /** The reply was cut off after some output (PRD §6) – it can be continued. */
  midStream?: boolean
  /** Models that were used for earlier parts of a continued reply. */
  continuedFrom?: string[]
}

export type MessageStatus = 'complete' | 'streaming' | 'error' | 'stopped'

export interface ChatMessageView {
  id: string
  conversationId: string
  role: 'user' | 'assistant'
  content: string
  status: MessageStatus
  meta: MessageMeta
  createdAt: number
}

export interface ConversationView extends ConversationSummary {
  messages: ChatMessageView[]
}

export type ChatEvent =
  | { type: 'start'; conversationId: string; messageId: string; provider: string; model: string; attempts: AttemptView[] }
  | { type: 'delta'; conversationId: string; messageId: string; content: string; reasoning: string }
  /** The final state of the message (complete, error or stopped). */
  | { type: 'end'; conversationId: string; message: ChatMessageView }

export interface ModelOptions {
  virtual: { value: string; label: string; hint: string }[]
  chains: string[]
  models: { id: string; label: string; provider: string; tags: CapabilityTag[] }[]
}

// ---- Settings (M6) -------------------------------------------------------

export interface RoutingSettings {
  weights: { quality: number; reliability: number; speed: number; headroom: number }
  topN: number
  maxPerProvider: number
  ttftTimeoutMs: number
  totalTimeoutMs: number
  allowFallbackWhenPinned: boolean
  minToolsQuality: number
  stickiness: boolean
}

export interface AppSettings {
  routing: RoutingSettings
  /** Excludes may-train-on-data providers for all chat and gateway traffic. */
  privateMode: boolean
  logRetentionDays: number
  launchAtLogin: boolean
  startMinimized: boolean
  /** Browser origins allowed to call the gateway (empty = none). */
  gatewayAllowedOrigins: string[]
}

export interface ChainView {
  name: string
  modelIds: string[]
}

// ---- Channels ------------------------------------------------------------

export interface IpcContract {
  'app:getInfo': { args: []; result: AppInfo }
  'gateway:getStatus': { args: []; result: GatewayStatus }
  'gateway:setEnabled': { args: [enabled: boolean]; result: GatewayStatus }
  'gateway:setPort': { args: [port: number]; result: GatewayStatus }
  /** The local gateway token (not a provider key) – shown so it can be pasted into tools. */
  'gateway:getToken': { args: []; result: string }
  'gateway:regenerateToken': { args: []; result: string }
  'gateway:recentRequests': { args: [limit: number]; result: GatewayRequestView[] }
  'settings:getTheme': { args: []; result: ThemePreference }
  'settings:setTheme': { args: [theme: ThemePreference]; result: ThemePreference }
  'providers:list': { args: []; result: ProviderView[] }
  'providers:setEnabled': { args: [providerId: string, enabled: boolean]; result: ProviderView[] }
  'providers:setLimitOverrides': { args: [providerId: string, overrides: Limits]; result: ProviderView[] }
  /** The only channel that carries a plaintext key – renderer → main, once. */
  'keys:add': { args: [input: AddKeyInput]; result: AddKeyResult }
  'keys:test': { args: [keyId: string]; result: KeyTestResult }
  'keys:setEnabled': { args: [keyId: string, enabled: boolean]; result: ProviderView[] }
  'keys:delete': { args: [keyId: string]; result: ProviderView[] }
  'models:list': { args: []; result: ModelView[] }
  'models:syncStatus': { args: []; result: ProviderSyncStatus[] }
  /** Sync one provider, or all when omitted. */
  'models:sync': { args: [providerId?: string]; result: SyncResult[] }
  'models:setEnabled': { args: [modelId: string, enabled: boolean]; result: ModelView }
  /** `null` for a profile clears the override. */
  'models:setQuality': { args: [modelId: string, quality: Partial<Record<QualityProfile, number | null>>]; result: ModelView }
  'models:test': { args: [modelId: string]; result: ModelTestResult }
  /** Requests sent today: per model, and per provider for account-wide limits (OpenRouter). */
  'models:usageToday': { args: []; result: { perModel: Record<string, number>; perProvider: Record<string, number> } }
  'chat:list': { args: []; result: ConversationSummary[] }
  'chat:get': { args: [conversationId: string]; result: ConversationView }
  'chat:create': { args: []; result: ConversationSummary }
  'chat:rename': { args: [conversationId: string, title: string]; result: ConversationSummary }
  'chat:delete': { args: [conversationId: string]; result: boolean }
  'chat:setOptions': {
    args: [conversationId: string, options: { model?: string; privateMode?: boolean }]
    result: ConversationSummary
  }
  /** Adds the user message and starts streaming the reply; events arrive on `chat:event`. */
  'chat:send': { args: [conversationId: string, text: string]; result: { userMessage: ChatMessageView; assistantMessageId: string } }
  /** Replaces the last reply, optionally with a different model or profile. */
  'chat:regenerate': { args: [conversationId: string, model?: string]; result: { assistantMessageId: string } }
  /** Continues a reply that was cut off, on a different model. */
  'chat:continue': { args: [conversationId: string, messageId: string]; result: { assistantMessageId: string } }
  'chat:stop': { args: [messageId: string]; result: boolean }
  'chat:modelOptions': { args: []; result: ModelOptions }
  'settings:get': { args: []; result: AppSettings }
  'settings:update': { args: [patch: Partial<Omit<AppSettings, 'routing'>> & { routing?: Partial<RoutingSettings> }]; result: AppSettings }
  'settings:resetRouting': { args: []; result: AppSettings }
  'chains:list': { args: []; result: ChainView[] }
  'chains:save': { args: [name: string, modelIds: string[]]; result: ChainView[] }
  'chains:delete': { args: [name: string]; result: ChainView[] }
}

export type IpcChannel = keyof IpcContract

/** Events pushed from main to renderer. */
export interface IpcEvents {
  'gateway:statusChanged': GatewayStatus
  /** A gateway request finished (live log). */
  'gateway:request': GatewayRequestView
  /** The registry changed (sync finished, model tested); the renderer refetches. */
  'models:changed': { reason: 'sync' | 'test' | 'edit' }
  'chat:event': ChatEvent
}

export type IpcEvent = keyof IpcEvents

/** Shape exposed on `window.freerouter` by the preload script. */
export interface FreeRouterApi {
  invoke<C extends IpcChannel>(channel: C, ...args: IpcContract[C]['args']): Promise<IpcContract[C]['result']>
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEvents[E]) => void): () => void
}

export const IPC_CHANNELS: readonly IpcChannel[] = [
  'app:getInfo',
  'gateway:getStatus',
  'gateway:setEnabled',
  'gateway:setPort',
  'gateway:getToken',
  'gateway:regenerateToken',
  'gateway:recentRequests',
  'settings:getTheme',
  'settings:setTheme',
  'providers:list',
  'providers:setEnabled',
  'providers:setLimitOverrides',
  'keys:add',
  'keys:test',
  'keys:setEnabled',
  'keys:delete',
  'models:list',
  'models:syncStatus',
  'models:sync',
  'models:setEnabled',
  'models:setQuality',
  'models:test',
  'models:usageToday',
  'chat:list',
  'chat:get',
  'chat:create',
  'chat:rename',
  'chat:delete',
  'chat:setOptions',
  'chat:send',
  'chat:regenerate',
  'chat:continue',
  'chat:stop',
  'chat:modelOptions',
  'settings:get',
  'settings:update',
  'settings:resetRouting',
  'chains:list',
  'chains:save',
  'chains:delete'
] as const

export const IPC_EVENTS: readonly IpcEvent[] = ['gateway:statusChanged', 'gateway:request', 'models:changed', 'chat:event'] as const
