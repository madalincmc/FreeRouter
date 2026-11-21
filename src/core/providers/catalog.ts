import { z } from 'zod'
import seed from './providers.json'

export const LimitsSchema = z
  .object({
    rpm: z.number().int().positive().optional(),
    rpd: z.number().int().positive().optional(),
    tpm: z.number().int().positive().optional(),
    tpd: z.number().int().positive().optional()
  })
  .strict()

export const CAPABILITY_TAGS = ['coding', 'reasoning', 'tools', 'vision', 'long_context', 'fast'] as const

/** Dotted paths into one entry of a provider's model list. Only `id` is required. */
const ModelFieldsSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    contextWindow: z.string().optional(),
    maxOutput: z.string().optional(),
    inputModalities: z.string().optional(),
    outputModalities: z.string().optional(),
    supportedParameters: z.string().optional(),
    toolsFlag: z.string().optional(),
    visionFlag: z.string().optional(),
    reasoningFlag: z.string().optional(),
    /** Entry is skipped when this boolean is false (e.g. Mistral embed models). */
    chatFlag: z.string().optional(),
    /** Entry is skipped when this boolean is false (e.g. Groq deactivated models). */
    active: z.string().optional()
  })
  .strict()

/** How to read a provider's model list. All provider differences are data here, not code. */
export const ModelsSpecSchema = z
  .object({
    /** Defaults to `${baseUrl}/models`. */
    url: z.url().optional(),
    auth: z.enum(['none', 'optional', 'required']),
    /** Header carrying the raw key instead of `Authorization: Bearer` (Gemini native API). */
    authHeader: z.string().optional(),
    /** Path to the array in the response; empty string means the response is the array. */
    listPath: z.string(),
    fields: ModelFieldsSchema,
    /** Regex removed from the raw id (Gemini's `models/` prefix). */
    idStrip: z.string().optional(),
    /** Entries must have `includes` inside the array at `path`. */
    require: z.array(z.object({ path: z.string(), includes: z.string() }).strict()).optional(),
    free: z.union([
      z.object({ all: z.literal(true) }).strict(),
      z
        .object({
          idSuffix: z.string().optional(),
          /** Free when every one of these price fields is zero. */
          zeroPricePaths: z.array(z.string()).optional()
        })
        .strict()
    ]),
    /** Case-insensitive substrings; matching model ids are not chat models (embeddings, TTS, …). */
    exclude: z.array(z.string()),
    defaultTags: z.array(z.enum(CAPABILITY_TAGS)).optional()
  })
  .strict()

export type ModelsSpec = z.infer<typeof ModelsSpecSchema>

export const ProviderProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    baseUrl: z.url(),
    keyUrl: z.url(),
    docsUrl: z.url(),
    /** The provider's terms of service; required, shown next to "Get a key" (see TERMS.md). */
    termsUrl: z.url(),
    keyPrefix: z.string().optional(),
    mayTrainOnData: z.boolean(),
    /** Who the limits apply to – drives the "extra keys don't add capacity" hint and quota sharing. */
    limitScope: z.enum(['account', 'organization', 'project', 'key']),
    /** Whether rotating several keys round-robin is allowed / useful. */
    keyRotation: z.boolean(),
    /**
     * Off for providers with no free API access (e.g. a card or billing is required). A provider
     * the user switched themselves, or that already has a key, is not affected.
     */
    defaultEnabled: z.boolean().optional(),
    limits: LimitsSchema,
    notes: z.string(),
    validation: z
      .object({
        url: z.url(),
        /** HTTP statuses that mean "this key is invalid" (Gemini answers 400 for a bad key). */
        invalidStatuses: z.array(z.number().int()).min(1),
        headers: z.record(z.string(), z.string()).optional(),
        /** POST with a JSON body for providers with no authenticated GET (NVIDIA: a 1-token chat call). */
        method: z.enum(['GET', 'POST']).optional(),
        body: z.record(z.string(), z.unknown()).optional()
      })
      .strict(),
    models: ModelsSpecSchema,
    /** Request quirks: parameters this provider rejects are removed before sending (PRD §8). */
    request: z.object({ stripParams: z.array(z.string()) }).strict().optional()
  })
  .strict()

export const CatalogSchema = z.object({
  version: z.number().int(),
  limitsNote: z.string(),
  providers: z.array(ProviderProfileSchema).min(1)
})

export type ProviderProfile = z.infer<typeof ProviderProfileSchema>
export type Catalog = z.infer<typeof CatalogSchema>

export function parseCatalog(data: unknown): Catalog {
  const catalog = CatalogSchema.parse(data)
  const ids = new Set<string>()
  for (const p of catalog.providers) {
    if (ids.has(p.id)) throw new Error(`Duplicate provider id: ${p.id}`)
    ids.add(p.id)
  }
  return catalog
}

/** The bundled catalog (limits are data, not code – PRD §5). */
export const bundledCatalog: Catalog = parseCatalog(seed)
