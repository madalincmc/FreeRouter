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

export const ProviderProfileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    baseUrl: z.url(),
    keyUrl: z.url(),
    docsUrl: z.url(),
    keyPrefix: z.string().optional(),
    mayTrainOnData: z.boolean(),
    /** Who the limits apply to – drives the "extra keys don't add capacity" hint and quota sharing. */
    limitScope: z.enum(['account', 'organization', 'project', 'key']),
    /** Whether rotating several keys round-robin is allowed / useful. */
    keyRotation: z.boolean(),
    limits: LimitsSchema,
    notes: z.string(),
    validation: z
      .object({
        url: z.url(),
        /** HTTP statuses that mean "this key is invalid" (Gemini answers 400 for a bad key). */
        invalidStatuses: z.array(z.number().int()).min(1),
        headers: z.record(z.string(), z.string()).optional()
      })
      .strict()
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
