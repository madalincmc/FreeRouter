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
  core/        pure TS: db migrations, security helpers, later router/adapters/registry (no Electron)
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
- **Database.** SQLite runs in WAL mode at `%APPDATA%/FreeRouter/freerouter.db`. Schema changes are new migration files; never edit a shipped migration.
- **Native modules.** `better-sqlite3` ≥13 ships N-API prebuilds that load in both Node (Vitest) and Electron. **Do not add `electron-builder install-app-deps` or `@electron/rebuild`.** A source build is unnecessary, and node-gyp fails because the repo path contains a space ("My PC").
- If `node_modules/electron/dist` is missing after an install, run `node node_modules/electron/install.js`.
- Keep core DB logic driver-agnostic through the `SqlDatabase` interface in `core/db/migrate.ts`.

## Commands

- `pnpm dev`: run the app with HMR
- `pnpm test`: Vitest
- `pnpm typecheck`: tsc for the node and web projects
- `pnpm build`: production bundle in `out/`
- `pnpm package`: NSIS installer in `dist/` (finished in M6)
