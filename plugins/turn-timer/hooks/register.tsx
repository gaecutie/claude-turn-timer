import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Codex, TurnTimer } from '../types'

const timer = atom({ plugin: 'turn-timer', key: 'timer' } as const, null as TurnTimer | null)
const codex = atom({ plugin: 'turn-timer', key: 'codex' } as const, null as Codex)

function fmt(s: number) {
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  if (h > 0) return `${h}h ${m % 60}m`
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`
}

// Is a Codex job (from the Codex plugin, /codex:rescue etc.) still queued or running?
// The plugin keeps its job list in state.json under its plugin data folder,
// or under $TMPDIR/codex-companion when it has none.
const JOBS_SCRIPT =
  'for f in $(find "$HOME/.claude/plugins/data" "${TMPDIR:-/tmp}/codex-companion" -name state.json -path "*codex*" 2>/dev/null); do ' +
  'grep -Eq \'"status": *"(running|queued)"\' "$f" && { echo yes; exit 0; }; done; echo no'

// Ask Codex itself for the signed-in account's usage limits, through `codex app-server`
// (the same server the Codex plugin talks to). Falls back to Codex's session logs.
const USAGE_SCRIPT = `
const { spawn } = require('child_process')
const fs = require('fs'), path = require('path'), os = require('os')
const out = x => { process.stdout.write(JSON.stringify(x)); process.exit(0) }
function fromLogs() {
  const root = path.join(os.homedir(), '.codex', 'sessions'); const files = []
  const walk = d => { try { for (const n of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, n.name); n.isDirectory() ? walk(p) : n.name.endsWith('.jsonl') && files.push(p) } } catch {} }
  walk(root)
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  for (const f of files.slice(0, 10)) {
    const lines = fs.readFileSync(f, 'utf8').split('\\n').reverse()
    for (const l of lines) { if (!l.includes('used_percent')) continue
      try { const j = JSON.parse(l); const r = j.payload?.rate_limits ?? j.rate_limits ?? j.payload?.info?.rate_limits
        if (r && (r.primary || r.secondary)) out({ source: 'logs', primary: r.primary, secondary: r.secondary }) } catch {} }
  }
  out({ error: 'no usage found' })
}
let child
try { child = spawn('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], shell: process.platform === 'win32' }) } catch { fromLogs() }
child.on('error', fromLogs)
const timer = setTimeout(() => { child.kill(); fromLogs() }, 8000)
let buf = ''
child.stdout.on('data', d => { buf += d; let i
  while ((i = buf.indexOf('\\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1)
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.id === 1) { send({ method: 'initialized' }); send({ id: 2, method: 'account/rateLimits/read' }) }
    if (m.id === 2) { clearTimeout(timer); child.kill()
      const r = m.result?.rateLimits
      if (r && (r.primary || r.secondary)) out({ source: 'codex', primary: r.primary, secondary: r.secondary })
      fromLogs() }
  } })
const send = m => child.stdin.write(JSON.stringify(m) + '\\n')
send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'turn-timer', version: '0.2.0' } } })
`

function limitText(label: string, l: any, nowSec: number) {
  if (!l) return null
  const used = l.usedPercent ?? l.used_percent
  if (typeof used !== 'number') return null
  const resetsAt = l.resetsAt ?? l.resets_at
  const reset = typeof resetsAt === 'number' ? resetsAt - nowSec : l.resets_in_seconds
  const r = typeof reset === 'number' && reset > 0 ? ` (resets in ${fmt(Math.round(reset)).replace(/ \d+s$/, '')})` : ''
  return `${label} ${Math.round(used)}%${r}`
}

async function refreshCodex($: any) {
  try {
    const { stdout } = await $.process.run(['node', '-e', USAGE_SCRIPT], { timeoutMs: 15000 })
    const j = JSON.parse(stdout.trim() || '{}')
    if (j.error) {
      await update($, codex, () => null)
      return
    }
    const nowSec = (await $.clock.now()) / 1000
    const parts = [limitText('5h', j.primary, nowSec), limitText('weekly', j.secondary, nowSec)].filter(Boolean)
    await update($, codex, () => (parts.length ? { text: `Codex: ${parts.join(' · ')}` } : null))
  } catch {
    // Codex or Node not available: hide the Codex part
  }
}

async function codexJobRunning($: any) {
  try {
    const { stdout } = await $.process.run(['sh', '-c', JOBS_SCRIPT], { timeoutMs: 5000 })
    return stdout.trim() === 'yes'
  } catch {
    return false
  }
}

export const register: Register = on => {
  let startedAt = 0
  let isWaiting = false
  let tick: any

  const stopTick = () => {
    tick?.cancel?.()
    tick?.stop?.()
    tick = undefined
  }

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await refreshCodex($)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    // Keep counting if Claude is picking back up after a Codex job.
    if (!isWaiting) startedAt = await $.clock.now()
    isWaiting = false
    await update($, timer, t => ({ isWorking: true, isWaitingOnCodex: false, seconds: t?.isWorking ? t.seconds : 0 }))
    stopTick()
    tick = $.clock.every(1000, async () => {
      const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
      await update($, timer, t => ({ isWorking: true, isWaitingOnCodex: t?.isWaitingOnCodex ?? false, seconds }))
    })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const result = await next(e)

    if (await codexJobRunning($)) {
      // Claude handed work to Codex: keep the clock running and check every few seconds.
      isWaiting = true
      await update($, timer, t => ({ isWorking: true, isWaitingOnCodex: true, seconds: t?.seconds ?? 0 }))
      stopTick()
      let n = 0
      tick = $.clock.every(1000, async () => {
        const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
        n += 1
        if (n % 3 === 0 && !(await codexJobRunning($))) {
          stopTick()
          isWaiting = false
          await update($, timer, () => ({ isWorking: false, isWaitingOnCodex: false, seconds }))
          await refreshCodex($)
          return
        }
        await update($, timer, () => ({ isWorking: true, isWaitingOnCodex: true, seconds }))
      })
    } else {
      stopTick()
      const seconds = Math.round(((await $.clock.now()) - startedAt) / 1000)
      await update($, timer, () => ({ isWorking: false, isWaitingOnCodex: false, seconds }))
    }

    await refreshCodex($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const t = await read($, timer)
    const c = await read($, codex)
    if (e.props.hasSurvey || (t === null && c === null)) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const label = t
      ? t.isWorking
        ? `⏳ Working for ${fmt(t.seconds)}${t.isWaitingOnCodex ? ' (waiting on Codex)' : ''}…`
        : `✓ Worked for ${fmt(t.seconds)}`
      : ''
    return (
      <Box>
        {t && <Text color={t.isWorking ? 'yellow' : 'green'}>{label}</Text>}
        {t && c && <Text dimColor>{'   '}</Text>}
        {c && <Text dimColor>{c.text}</Text>}
      </Box>
    )
  })
}
