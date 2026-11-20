// Guards the architecture rules from CLAUDE.md.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(name) ? [p] : []
  })
}

const IMPORT_RE = /(?:import|export)[^'"]*from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g

function importsOf(file: string): string[] {
  const src = readFileSync(file, 'utf8')
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1] ?? m[2] ?? m[3]!)
}

describe('architecture', () => {
  it('src/core never imports Electron or app layers', () => {
    const offenders = filesUnder('src/core').flatMap((f) =>
      importsOf(f)
        .filter((spec) => spec === 'electron' || spec.startsWith('electron/') || /(^|\/)(main|renderer|preload)\//.test(spec))
        .map((spec) => `${relative('.', f)} -> ${spec}`)
    )
    expect(offenders).toEqual([])
  })

  it('the renderer only reaches main through the preload bridge', () => {
    const offenders = filesUnder('src/renderer/src').flatMap((f) =>
      importsOf(f)
        .filter((spec) => spec === 'electron' || spec.startsWith('node:') || spec === 'better-sqlite3' || spec.startsWith('@core/'))
        .map((spec) => `${relative('.', f)} -> ${spec}`)
    )
    expect(offenders).toEqual([])
  })
})
