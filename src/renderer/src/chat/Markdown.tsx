import { Children, isValidElement, memo, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'

/** Plain text of rendered children (highlighted code is nested spans). */
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children)
  return ''
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
      aria-label={label}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {copied ? 'Copied' : label}
    </button>
  )
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const code = Children.toArray(children)[0]
  const className = isValidElement<{ className?: string }>(code) ? (code.props.className ?? '') : ''
  const lang = /language-([\w-]+)/.exec(className)?.[1]
  return (
    <div className="group my-3 overflow-hidden rounded-md border border-border bg-bg">
      <div className="flex items-center justify-between border-b border-border bg-panel-2/60 px-3 py-1">
        <span className="font-mono text-[11px] text-muted">{lang ?? 'text'}</span>
        <CopyButton text={textOf(children).replace(/\n$/, '')} />
      </div>
      <pre className="selectable overflow-x-auto p-3 font-mono text-[13px] leading-relaxed">{children}</pre>
    </div>
  )
}

/**
 * Markdown for model output. Raw HTML is never rendered (react-markdown default) and remote
 * images are blocked by the CSP; links open in the system browser via the window open handler.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat selectable">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
})
