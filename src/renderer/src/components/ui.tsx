import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

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

export function Card({ title, children, className = '' }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg border border-border bg-panel p-5 ${className}`}>
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

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-accent-fg hover:opacity-90',
  secondary: 'border border-border bg-panel-2 text-fg hover:border-muted/50',
  ghost: 'text-muted hover:bg-panel-2 hover:text-fg',
  danger: 'border border-err/40 text-err hover:bg-err/10'
}

export function Button({
  variant = 'secondary',
  size = 'md',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' }) {
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-[color,background,border,opacity] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50 ${
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-sm'
      } ${VARIANTS[variant]} ${className}`}
    />
  )
}

export function TextInput({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`selectable h-8 rounded-md border border-border bg-bg px-2.5 text-sm text-fg placeholder:text-muted/70 focus:border-accent focus:outline-none ${className}`}
    />
  )
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
  label: string
}) {
  return (
    <label className="relative inline-flex shrink-0 cursor-pointer items-center" title={label}>
      <input
        type="checkbox"
        className="peer sr-only"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="h-5 w-9 rounded-full bg-panel-2 ring-1 ring-border transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-disabled:opacity-50" />
      <span className="absolute left-0.5 h-4 w-4 rounded-full bg-fg transition-transform peer-checked:translate-x-4 peer-checked:bg-accent-fg" />
    </label>
  )
}

type Tone = 'neutral' | 'ok' | 'warn' | 'err' | 'accent'

const TONES: Record<Tone, string> = {
  neutral: 'bg-panel-2 text-muted',
  ok: 'bg-ok/12 text-ok',
  warn: 'bg-warn/12 text-warn',
  err: 'bg-err/12 text-err',
  accent: 'bg-accent/15 text-accent'
}

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone]}`}>
      {children}
    </span>
  )
}

export function Dot({ tone }: { tone: Tone }) {
  const color = { neutral: 'bg-muted', ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err', accent: 'bg-accent' }[tone]
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${color}`} />
}
