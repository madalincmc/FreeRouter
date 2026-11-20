# FreeRouter Desktop

A Windows Electron app that pools free hosted LLMs behind one router. It has two front doors, a chat UI and a local OpenAI-compatible gateway at `127.0.0.1:4141/v1`. No inference runs locally.

- PRD: https://claude.ai/artifact/F6629dKfWfwb6KYBRovLqP (the Claude doc "PRD – Free Model Orchestrator")
- Linear: project P-MAD-9, team MAD. There is one milestone per build step, M0–M6 (PRD §13). Build one milestone at a time.

## Rules (non-negotiable)

- **`src/core/` must never import Electron**, or anything from `main/`, `preload/` or `renderer/`. The router, adapters, registry and migrations are pure TypeScript, unit-tested without Electron. `tests/architecture.test.ts` enforces this.
- **Never log or return a raw key.** Keys are decrypted only in the main process, at call time, with `safeStorage` (DPAPI). The renderer receives only masked values (`sk-or-…a91f`). Every log line and every error that crosses IPC goes through `redact()` / `redactError()` in `src/core/security/redact.ts`.
- **Every provider quirk goes in that provider's profile** (`providers.json` / profile objects), never in `if (provider === ...)` branches.
- **Limits are data** in `providers.json`. They are overridden by `x-ratelimit-*` headers and edited by the user in Settings.
- **Before finishing any task, run `pnpm test` and `pnpm typecheck`.** Both must pass.

## Layout

```
src/
  core/        pure TS: db migrations, security helpers, key vault/validation, provider catalog,
               model registry (discover/enrich/store/sync), routing errors (no Electron)
    db/migrations/NNNN_name.sql   plain-SQL migrations, numbered 1..n, inlined via import.meta.glob
  shared/      types shared by main, preload and renderer (the IPC contract lives in ipc.ts)
  main/        Electron main process: window hardening, tray, SQLite (better-sqlite3), IPC handlers
  preload/     contextBridge exposing `window.freerouter` (allow-listed channels only, CJS for the sandbox)
  renderer/    React 19 + Tailwind v4 + Zustand + TanStack Query
tests/         Vitest suites (Node, no Electron)
resources/     icons (icon.png for app/installer, tray.png for the tray)
```

## Conventions

- **IPC.** To add a channel: add it to `IpcContract` and `IPC_CHANNELS` in `src/shared/ipc.ts`, add a Zod schema in `argSchemas` in `src/main/ipc.ts`, then register it with `handle(...)`. In the renderer, use `useIpcQuery` / `useIpcMutation` from `renderer/src/lib/ipc.ts`.
- **Security.** Keep `contextIsolation: true`, `nodeIntegration: false` and `sandbox: true`, keep the strict CSP in `renderer/index.html` (it is relaxed only in dev), and don't load remote content in the renderer. External links open in the system browser.
- **Keys.** `KeyVault` (`core/keys/vault.ts`) is the only code that touches ciphertext, and `reveal()` is the only plaintext path (main process, at call time). Use Electron's **async** safeStorage API (`encryptStringAsync`/`decryptStringAsync`/`isAsyncEncryptionAvailable`); the sync API is deprecated in Electron 45. The vault re-encrypts when `shouldReEncrypt` is set. Never fall back to plaintext.
- **Providers.** Static profiles live in `core/providers/providers.json` (Zod-validated in `catalog.ts`). User state (enabled flag, limit overrides) lives in the `providers` table. Validation quirks are profile data: `validation.url`, `invalidStatuses` (Gemini returns 400 for a bad key) and `headers`. OpenRouter's `/models` is public, so its keys are validated with `/api/v1/key`. **GitHub Models was retired on 2026-07-30** and was removed from the catalog; its endpoints now answer a plain `OK` for every request.
- **Registry.** Each profile's `models` spec says how to read the provider's list: dotted field paths, `listPath`, `idStrip`, `require`, `exclude` and free detection. Parsing (`core/registry/discover.ts`) is generic, so never branch on the provider id. Gemini uses its native `/v1beta/models` (with an `x-goog-api-key` header), because the OpenAI-compatible list has no token limits. Chat routing needs text-only output, so music and image generators are dropped. Tags and quality come from `core/registry/seed.json` (first matching regex wins), then metadata and name heuristics (`enrich.ts`). User quality edits live in `quality_override_json` and survive syncs. A model missing from 2 consecutive successful syncs becomes `gone`. A failed or empty sync never touches models.
- **Failure classification** is in `core/routing/errors.ts`, shared by "test now" and the router.
- **Router** (`core/routing/router.ts`). `route(req, opts)` is an async generator of `start` → `chunk`* → `done`, or of a terminal `error` (`midStream: true` once tokens were sent). The flow is intent (`intent.ts`) → `rank()` (`candidates.ts`: filter, score, diversify) → a fallback loop over at most `topN` candidates. Upstream calls always use `stream: true`; a provider that answers with JSON anyway is converted into chunks. Time to first token counts from the first *meaningful* delta, so a role-only chunk doesn't count. 429s cool a model down but don't lower its reliability score. Server errors, timeouts and network failures do, and 3 in a row cool the model down for 5 minutes. 401 flags the key. 400s skip the model for this request only.
- **Quota** (`quota.ts`). Sliding 60 s windows live in memory. Per-UTC-day counters persist in `usage_counters`. `counterKey(key, model, accountWide)` puts every model under `*` for account-wide providers (OpenRouter). Header hints (`x-ratelimit-remaining-*`) override the local counts until their reset.
- **Router tests** use `tests/fakeProvider.ts`, a real HTTP server with scripted behaviours per model, through `tests/routerHarness.ts`. Add a scripted behaviour there rather than mocking fetch.
- **Database.** SQLite runs in WAL mode at `%APPDATA%/FreeRouter/freerouter.db`. Schema changes are new migration files; never edit a shipped migration.
- **Native modules.** `better-sqlite3` ≥13 ships N-API prebuilds that load in both Node (Vitest) and Electron. **Do not add `electron-builder install-app-deps` or `@electron/rebuild`.** A source build is unnecessary, and node-gyp fails because the repo path contains a space ("My PC").
- If `node_modules/electron/dist` is missing after an install, run `node node_modules/electron/install.js`.
- Keep core DB logic driver-agnostic through the `SqlDatabase` interface in `core/db/migrate.ts`.

- **Chat** (`core/chat/`). `ConversationStore` holds the SQLite history. `ChatService` drives the router: it coalesces deltas (30 ms) into `chat:event` IPC events and persists the final message. On startup, `recoverInterrupted()` marks replies left `streaming` as stopped. "Continue with another model" sends the partial reply plus `CONTINUE_PROMPT`, passes `excludeModels: [failedModel]`, and appends the continuation to the same message. In the renderer, `useChatEvents()` is mounted at the App level. Live text sits in a zustand store keyed by message id and is swapped for the final message when the `end` event arrives.
- **Gateway** (`core/gateway/`, controller in `main/gateway.ts`).
  - It's Fastify, bound to `127.0.0.1` only.
  - The `onRequest` hook checks Host (DNS rebinding), then Origin (403 unless allow-listed in `gateway.allowedOrigins`), then the `fr-local-…` token on `/v1/*` (401). It accepts `Bearer` or `x-api-key`. The token is stored encrypted with safeStorage under `gateway.tokenEnc`.
  - Streaming responses hijack the reply and write headers only on the router's `start` event. So `x-fr-provider`, `x-fr-model` and `x-fr-attempts` are real, and failures before the first token return a proper HTTP error instead of a 200 stream. A mid-stream failure becomes `data: {"error":…}` and the stream ends.
  - Non-streaming responses are aggregated with `CompletionAggregator`.
  - A client disconnect aborts the upstream call.
- **Normalisation** (`core/routing/normalize.ts`) runs inside the router, so chat benefits too:
  - `buildUpstreamBody` removes `GLOBAL_STRIP_PARAMS` and each profile's `request.stripParams`. That list is best-effort data; a 400 still fails over.
  - `ChunkNormalizer` fixes tool-call deltas (index, id, type, string arguments) and finish reasons.
- **Model output safety.** react-markdown never renders raw HTML. The CSP blocks remote images. Links open in the system browser.
- **Dev end-to-end without keys.** Run `pnpm dev:fake`, then start the app with `FREEROUTER_DATA_DIR=<temp dir>` and `FREEROUTER_DEV_FAKE_PROVIDER=<FAKE_URL>` (see `src/main/devHooks.ts`). Both are ignored in packaged builds. Always use a separate data dir so the real profile isn't touched.

## Commands

- `pnpm dev`: run the app with HMR
- `pnpm test`: Vitest
- `pnpm typecheck`: tsc for the node and web projects
- `pnpm build`: production bundle in `out/`
- `pnpm package`: NSIS installer in `dist/` (finished in M6)
