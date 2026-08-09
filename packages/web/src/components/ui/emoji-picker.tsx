"use client"

import { useState, useMemo, useRef, useEffect } from "react"
import emojilib from "emojilib"
import { EMOJI_POOL } from "@/lib/emoji-pool"

interface EmojiPickerProps {
  current: string
  onSelect: (emoji: string) => void
  onClose: () => void
}

// Pre-build searchable list: each entry has the emoji + all keyword tags joined
const ALL_EMOJIS: Array<{ emoji: string; keywords: string[] }> = []
for (const [emoji, keywords] of Object.entries(emojilib as Record<string, string[]>)) {
  ALL_EMOJIS.push({ emoji, keywords })
}

export function EmojiPicker({ current, onSelect, onClose }: EmojiPickerProps) {
  const [search, setSearch] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [onClose])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    if (!q) return null
    const results: Array<{ emoji: string; label: string }> = []
    for (const entry of ALL_EMOJIS) {
      if (entry.keywords.some((kw) => kw.includes(q))) {
        results.push({ emoji: entry.emoji, label: entry.keywords[0] })
        if (results.length >= 80) break
      }
    }
    return results
  }, [search])

  return (
    <div
      ref={containerRef}
      className="absolute top-full left-0 z-50 mt-2 rounded-[var(--radius-lg,16px)] border border-[var(--separator)] bg-[var(--material-thick)] p-3 shadow-[var(--shadow-overlay)] backdrop-blur-xl"
      style={{ width: 320 }}
    >
      <input
        ref={inputRef}
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search emojis (gym, happy, food...)"
        className="mb-2 w-full rounded-[var(--radius-md)] bg-[var(--fill-tertiary)] px-3 py-1.5 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
      />

      <div style={{ maxHeight: 240, overflowY: "auto" }}>
        {filtered === null ? (
          <>
            <p className="text-[length:var(--text-caption2)] font-[var(--weight-semibold)] uppercase tracking-[var(--tracking-wide)] text-[var(--text-tertiary)] mb-1.5">
              Suggested
            </p>
            <div className="grid grid-cols-8 gap-1">
              {EMOJI_POOL.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => onSelect(emoji)}
                  className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1.5 text-xl transition-colors ${emoji === current ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
          </>
        ) : filtered.length === 0 ? (
          <p className="py-4 text-center text-xs text-[var(--text-tertiary)]">
            No emojis found for &ldquo;{search}&rdquo;
          </p>
        ) : (
          <>
            <p className="text-[length:var(--text-caption2)] text-[var(--text-tertiary)] mb-1.5">
              {filtered.length >= 80 ? "80+" : filtered.length} results
            </p>
            <div className="grid grid-cols-8 gap-1">
              {filtered.map((e) => (
                <button
                  key={e.emoji}
                  onClick={() => onSelect(e.emoji)}
                  title={e.label}
                  className={`flex items-center justify-center rounded-[var(--radius-md,12px)] p-1.5 text-xl transition-colors ${e.emoji === current ? "bg-[var(--accent-fill)] border border-[var(--accent)]" : "bg-transparent border border-transparent hover:bg-[var(--fill-secondary)]"}`}
                >
                  {e.emoji}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
