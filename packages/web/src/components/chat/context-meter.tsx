'use client'

import {
  contextFraction,
  contextLevel,
  contextWindowFor,
  formatContextTokens,
} from '@/lib/context-meter'

const LEVEL_COLOR: Record<string, string> = {
  ok: 'var(--accent)',
  warn: '#e6a23c',
  critical: '#e05252',
}

interface ContextMeterProps {
  tokens: number | null | undefined
  model?: string | null
}

/**
 * Inline context-meter badge: a thin bar + compact token count showing how full
 * the model's context window is. Renders nothing until the gateway reports a
 * token count, so idle/fresh sessions stay clean.
 */
export function ContextMeter({ tokens, model }: ContextMeterProps) {
  if (typeof tokens !== 'number' || tokens <= 0) return null

  const fraction = contextFraction(tokens, model)
  const level = contextLevel(fraction)
  const color = LEVEL_COLOR[level]
  const window = contextWindowFor(model)
  const pct = Math.round(fraction * 100)

  return (
    <div
      title={`Context: ${formatContextTokens(tokens)} / ${formatContextTokens(window)} (${pct}%)`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        fontSize: 'var(--text-caption, 12px)',
        color: 'var(--text-secondary)',
      }}
    >
      <span
        aria-hidden
        style={{
          position: 'relative',
          width: '56px',
          height: '4px',
          borderRadius: '2px',
          background: 'var(--surface-2, rgba(127,127,127,0.2))',
          overflow: 'hidden',
        }}
      >
        <span
          style={{
            position: 'absolute',
            inset: 0,
            width: `${pct}%`,
            background: color,
            transition: 'width 200ms ease',
          }}
        />
      </span>
      <span style={{ color }}>
        {formatContextTokens(tokens)} ({pct}%)
      </span>
    </div>
  )
}
