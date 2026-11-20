import type { ModelOptions } from '@shared/ipc'

/** Auto / profile / chain / pinned model picker (PRD §9). */
export function ModelPicker({
  value,
  options,
  onChange,
  label = 'Model',
  placeholder,
  className = ''
}: {
  value: string
  options: ModelOptions | undefined
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  className?: string
}) {
  const known =
    !value ||
    options?.virtual.some((v) => v.value === value) ||
    options?.chains.some((c) => `chain:${c}` === value) ||
    options?.models.some((m) => m.id === value)
  const byProvider = new Map<string, NonNullable<ModelOptions>['models']>()
  for (const m of options?.models ?? []) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m])

  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`h-8 max-w-64 rounded-md border border-border bg-bg px-2 text-sm text-fg ${className}`}
    >
      {placeholder && (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      <optgroup label="Automatic">
        {options?.virtual.map((v) => (
          <option key={v.value} value={v.value} title={v.hint}>
            {v.label}
          </option>
        ))}
      </optgroup>
      {!!options?.chains.length && (
        <optgroup label="Fallback chains">
          {options.chains.map((c) => (
            <option key={c} value={`chain:${c}`}>
              Chain: {c}
            </option>
          ))}
        </optgroup>
      )}
      {[...byProvider].map(([provider, models]) => (
        <optgroup key={provider} label={provider}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </optgroup>
      ))}
      {!known && <option value={value}>{value} (not available now)</option>}
    </select>
  )
}
