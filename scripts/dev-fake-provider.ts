/**
 * Runs the test fake provider (tests/fakeProvider.ts) as a standalone server so the app can be
 * exercised end to end without real keys. Pair it with the dev hooks in src/main/devHooks.ts:
 *
 *   pnpm dev:fake            → prints FAKE_URL=http://127.0.0.1:<port>
 *   FREEROUTER_DATA_DIR=<tmp dir> FREEROUTER_DEV_FAKE_PROVIDER=<FAKE_URL> pnpm dev
 *
 * Scripted models (provider "devfake"):
 *   smart-400b – first call 429 (shows a fallback), then a Markdown answer
 *   quick-30b  – fast Markdown answer
 *   flaky-120b – breaks mid-stream (exercises "continue with another model")
 */
import { FakeProvider } from '../tests/fakeProvider.ts'

const story =
  'Here is a **Markdown** reply with code:\n\n```ts\nexport function add(a: number, b: number): number {\n  return a + b // sum\n}\n```\n\n- one\n- two\n\n| a | b |\n|---|---|\n| 1 | 2 |\n'

const fake = new FakeProvider()
fake.setModels('devfake', [
  { id: 'smart-400b', context_length: 131072, supported_parameters: ['tools', 'response_format'] },
  { id: 'quick-30b', context_length: 32768 },
  { id: 'flaky-120b', context_length: 131072 }
])
fake.script(
  'devfake',
  'smart-400b',
  { kind: 'status', status: 429, headers: { 'retry-after': '2' }, body: { error: { message: 'Rate limit reached' } } },
  { kind: 'ok', text: story, chunkDelayMs: 15 }
)
fake.script('devfake', 'quick-30b', { kind: 'ok', text: `Quick answer from the 30b model. ${story}`, chunkDelayMs: 10 })
fake.script('devfake', 'flaky-120b', { kind: 'break', afterChunks: 3 })

const url = await fake.start()
console.log(`FAKE_URL=${url}`)
process.on('SIGINT', () => void fake.stop().then(() => process.exit(0)))
setInterval(() => {}, 1 << 30)
