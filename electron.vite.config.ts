import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

/** In dev only, allow the React Refresh inline preamble and the Vite HMR websocket. */
function cspDev(): Plugin {
  return {
    name: 'csp-dev',
    apply: 'serve',
    transformIndexHtml: (html) =>
      html
        .replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
        .replace("connect-src 'self'", "connect-src 'self' ws://localhost:* http://localhost:*")
  }
}

const alias = {
  '@core': resolve('src/core'),
  '@shared': resolve('src/shared')
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        // Plain-SQL migrations are copied next to the bundle (see main/db/migrations.ts).
        input: { index: resolve('src/main/index.ts') }
      }
    }
  },
  preload: {
    resolve: { alias },
    build: {
      // Sandboxed preloads must be a single CommonJS file with no node_modules imports.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    resolve: { alias: { ...alias, '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), tailwindcss(), cspDev()]
  }
})
