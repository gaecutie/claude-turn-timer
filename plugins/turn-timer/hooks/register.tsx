import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Codex, Timer } from '../types'

const timer = atom({ plugin: 'turn-timer', key: 'timer' } as const, null as Timer | null)
const codex = atom({ plugin: 'turn-timer', key: 'codex' } as const, null as Codex)

const fmt = (s: number) => {
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// Codex CLI writes its rate limits into its session logs (~/.codex/sessions).
const CODEX_SCRIPT =
  'f=$(find "$HOME/.codex/sessions" -name "*.jsonl" 2>/dev/null | xargs ls -t 2>/dev/null | head -1); ' +
  '[ -n "$f" ] && grep rate_limits "$f" | tail -1'

const limitText = (label: string, l: any) => {
  if (!l || typeof l.used_percent !== 'number') return null
  const reset = l.resets_in_seconds ?? (l.resets_at ? l.resets_at - Date.now() / 1000 : undefined)
  const r = typeof reset === 'number' && reset > 0 ? ` (resets in ${fmt(Math.round(reset)).replace(/ \d+s$/, '')})` : ''
  return `${label} ${Math.round(l.used_percent)}%${r}`
}

async function refreshCodex($: any) {
  try {
    const { stdout } = await $.process.run(['sh', '-c', CODEX_SCRIPT], { timeoutMs: 5000 })
    const line = stdout.trim()
    if (!line) return update($, codex, () => null)
    const j = JSON.parse(line)
    const rl = j.rate_limits ?? j.payload?.rate_limits ?? j.payload?.info?.rate_limits
    const parts = [limitText('5h', rl?.primary), limitText('weekly', rl?.secondary)].filter(Boolean)
    await update($, codex, () => (parts.length ? { text: `Codex: ${parts.join(' · ')}` } : null))
  } catch {
    // no Codex installed or unreadable log: just hide the Codex part
  }
}

export const register: Register = on => {
  let startedAt = 0
  let tick: { cancel?: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await refreshCodex($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    startedAt = await $.clock.now()
    await update($, timer, () => ({ isWorking: true, seconds: 0 }))
    tick?.cancel?.()
    tick = $.clock.every(1000, async () => {
      const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
      await update($, timer, () => ({ isWorking: true, seconds }))
    }) as any
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    tick?.cancel?.()
    tick = undefined
    const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
    await update($, timer, () => ({ isWorking: false, seconds }))
    await refreshCodex($)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, timer)
    const c = await read($, codex)
    if (e.props.hasSurvey || (t === null && c === null)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box>
        {t && (
          <Text color={t.isWorking ? 'yellow' : 'green'}>
            {t.isWorking ? `⏳ Working for ${fmt(t.seconds)}…` : `✓ Worked for ${fmt(t.seconds)}`}
          </Text>
        )}
        {t && c && <Text dimColor>{'   '}</Text>}
        {c && <Text dimColor>{c.text}</Text>}
      </Box>
    )
  })
}
