import type { ReactNode } from 'react'

export function Page({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-8 py-7">
      <header className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </header>
      {children}
    </div>
  )
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-5">
      {title && <h2 className="mb-3 text-sm font-semibold">{title}</h2>}
      {children}
    </section>
  )
}

/** Placeholder for screens whose functionality lands in a later milestone. */
export function ComingIn({ milestone, children }: { milestone: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-panel/50 px-6 py-10 text-center">
      <span className="rounded-full bg-panel-2 px-2.5 py-1 text-xs font-medium text-muted">{milestone}</span>
      <p className="mx-auto mt-3 max-w-md text-sm text-muted">{children}</p>
    </div>
  )
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-6 border-b border-border py-2.5 text-sm last:border-0">
      <span className="text-muted">{label}</span>
      <span className="selectable truncate text-right font-mono text-[13px]">{children}</span>
    </div>
  )
}
