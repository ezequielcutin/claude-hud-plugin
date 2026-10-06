import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { HudAgent, HudCheckpoint, HudGit, HudRtk, HudSegment } from '../types'

const SEGMENTS: HudSegment[] = ['rtk', 'turn', 'git', 'skill', 'agents']
const EDITING_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

// Desktop: instrument cluster, graphite chips that sit on the host's grey, one hue per signal
const DESK = {
  chip: '#2a2a2a',
  chipHover: '#353535',
  text: '#ebe7e1',
  dim: '#9a958e',
  faint: '#5c5852',
  rule: '#3d3a36',
  live: '#e0895f',
  skill: '#b9a3e3',
  agents: '#7fb3d5',
  amber: '#e2b261',
  green: '#8fc79b',
  red: '#e0727a',
  mark: '#cdb47e',
}
// Terminal: neon on slate, each chip led by an accent edge
const CLI: typeof DESK = {
  chip: '#121826',
  chipHover: '#1c2638',
  text: '#e2e8f0',
  dim: '#64748b',
  faint: '#334155',
  rule: '#334155',
  live: '#22d3ee',
  skill: '#a78bfa',
  agents: '#60a5fa',
  amber: '#fbbf24',
  green: '#34d399',
  red: '#f87171',
  mark: '#f0abfc',
}
// A finished agent stays in the tree this long before it drops out
const LINGER_MS = 60_000
// An agent that just stopped may only be waiting on a background command, so it reads as
// waiting this long before it reads as done (otherwise its glyph flips ✓ ↔ spinner)
const SETTLE_MS = 8_000
// How long the checkpoint button reports a result before it reads as ready again
const CHECKPOINT_SHOW_MS = 30_000
const CHECKPOINT_PROMPT = `Write a checkpoint of this session: a handoff document that another agent can pick up cold. That agent may be a different harness (Codex, Cursor, a fresh Claude Code session) with none of this conversation, so the document must stand alone: never refer to "above", "earlier" or "this conversation".

Markdown, exactly these sections, each a few tight bullets (at most 5):
# <a short title naming the work>
## Goal
What the person is trying to achieve, and why.
## Current state
What is built and verified, what is built but unverified, what is broken.
## Decisions
Choices made and the reason for each, including the person's stated preferences.
## Key files
\`path\`: its role, one line each.
## Next steps
Ordered, concrete, each one actionable.
## Gotchas
Environment quirks, things that failed and why, traps to avoid.

Be concrete: real paths, commands, names, numbers. Leave out any path that exists only for this session (temp files, scratchpads, anything under /tmp or /private/tmp): the reader won't have it.

This document is being written by a checkpoint run, and that run is itself proof of whatever it exercises: the checkpoint's trigger, its file naming and header, where it is saved, how its path is reported, and the prompt producing this text all work. Count them as verified, and never list writing, checking or confirming a checkpoint, or its output, as unverified or as a next step.

Keep it under 500 words: a reader skims this. Output only the document.`
const SPIN = ['◴', '◷', '◶', '◵']
const BARS = '▁▂▃▄▅▆▇█'

// Everything lives in $.state, so a reload keeps the session's numbers
const rtk = atom({ plugin: 'neon-hud', key: 'rtk' } as const, { commands: 0, input: 0, saved: 0 })
const rtkTrend = atom({ plugin: 'neon-hud', key: 'rtkTrend' } as const, { perTurn: [], savedAtTurnStart: 0, top: {} })
const rtkAllTime = atom({ plugin: 'neon-hud', key: 'rtkAllTime' } as const, null)
const turn = atom({ plugin: 'neon-hud', key: 'turn' } as const, { startedAt: null, tools: 0, lastMs: null, lastTools: 0 })
const toolMix = atom({ plugin: 'neon-hud', key: 'toolMix' } as const, { current: {}, last: {} })
const stats = atom({ plugin: 'neon-hud', key: 'stats' } as const, { turns: 0, tools: 0 })
const git = atom({ plugin: 'neon-hud', key: 'git' } as const, null)
const skill = atom({ plugin: 'neon-hud', key: 'skill' } as const, null)
const skillHistory = atom({ plugin: 'neon-hud', key: 'skillHistory' } as const, [])
const agents = atom({ plugin: 'neon-hud', key: 'agents' } as const, { running: 0, list: [] })
const checkpoint = atom({ plugin: 'neon-hud', key: 'checkpoint' } as const, {
  status: 'idle', startedAt: null, endedAt: null, path: null, error: null,
} as HudCheckpoint)
const hidden = atom({ plugin: 'neon-hud', key: 'hidden' } as const, [])

// ---- settings and external tools ----

type Timezone = 'local' | 'utc' | 'us-eastern'
type Config = { defaultHidden: Set<HudSegment>; timezone: Timezone; checkpointDir: string; rtkPath: string; rtkDb: string }

function readConfig(options: PluginOptions): Config {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const tz = str(options.timezone)
  return {
    defaultHidden: new Set(
      str(options.hidden_segments).split(',').map(x => x.trim()).filter((x): x is HudSegment => (SEGMENTS as string[]).includes(x)),
    ),
    timezone: tz === 'utc' || tz === 'us-eastern' ? tz : 'local',
    checkpointDir: str(options.checkpoint_dir).replace(/^~\//, '').replace(/\/+$/, '') || '.claude/checkpoints',
    rtkPath: str(options.rtk_path),
    rtkDb: str(options.rtk_db),
  }
}

let config: Config = readConfig({})

// A segment is hidden when the settings hide it at start, flipped by each /hud <segment> toggle
function hiddenSegments(toggled: readonly HudSegment[]): HudSegment[] {
  const off = SEGMENTS.filter(s => config.defaultHidden.has(s) !== toggled.includes(s))
  return isRtkReady() || off.includes('rtk') ? off : [...off, 'rtk']
}

// External tools, found once per load. A desktop app's PATH often lacks Homebrew's bin, so the
// usual install locations are checked first and a bare name on PATH is the fallback.
type Tools = { git: string; sqlite: string | null; rtk: string | null; rtkDb: string | null }
let tools: Tools = { git: 'git', sqlite: null, rtk: null, rtkDb: null }
const BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

async function isFile($: EngineInterface, path: string): Promise<boolean> {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

async function firstFile($: EngineInterface, paths: (string | null | undefined)[]): Promise<string | null> {
  for (const path of paths) if (path && (await isFile($, path))) return path
  return null
}

async function resolveTools($: EngineInterface): Promise<Tools> {
  const home = await $.env.get('HOME')
  const xdgData = await $.env.get('XDG_DATA_HOME')
  const expand = (path: string) => (home ? path.replace(/^~(?=\/|$)/, home) : path)
  const dirs = [...BIN_DIRS, home && `${home}/.cargo/bin`, home && `${home}/.local/bin`].filter((d): d is string => !!d)
  const bin = (name: string, override = '') => firstFile($, [override && expand(override), ...dirs.map(d => `${d}/${name}`)])
  const [git, sqlite, rtk, rtkDb] = await Promise.all([
    bin('git'),
    bin('sqlite3'),
    bin('rtk', config.rtkPath),
    firstFile($, [
      config.rtkDb && expand(config.rtkDb),
      home && `${home}/Library/Application Support/rtk/history.db`,
      (xdgData || (home && `${home}/.local/share`)) && `${xdgData || `${home}/.local/share`}/rtk/history.db`,
    ]),
  ])
  return { git: git ?? 'git', sqlite, rtk, rtkDb }
}

function isRtkReady(): boolean {
  return tools.rtk !== null && tools.sqlite !== null && tools.rtkDb !== null
}

// ---- data sources ----

type RtkRow = { id: number; original_cmd: string; input_tokens: number; saved_tokens: number }

async function rtkQuery($: EngineInterface, sql: string): Promise<RtkRow[]> {
  if (!isRtkReady()) return []
  try {
    const { exitCode, stdout } = await $.process.run([tools.sqlite as string, '-json', tools.rtkDb as string, sql], { timeoutMs: 5_000 })
    return exitCode === 0 && stdout.trim() ? JSON.parse(stdout) : []
  } catch {
    return []
  }
}

async function rtkMaxId($: EngineInterface): Promise<number | null> {
  const [row] = await rtkQuery($, 'select coalesce(max(id), 0) as id from commands')
  return row ? row.id : null
}

async function refreshRtkAllTime($: EngineInterface) {
  if (!isRtkReady()) return
  try {
    const { exitCode, stdout } = await $.process.run([tools.rtk as string, 'gain', '--format', 'json'], { timeoutMs: 10_000 })
    if (exitCode === 0) await update($, rtkAllTime, () => JSON.parse(stdout).summary.total_saved)
  } catch {}
}

let isGitRefreshing = false

async function refreshGit($: EngineInterface) {
  if (isGitRefreshing) return
  isGitRefreshing = true
  try {
    const { exitCode, stdout } = await $.process.run([tools.git, 'status', '--porcelain=v1', '--branch'], { timeoutMs: 5_000 })
    if (exitCode !== 0) {
      await update($, git, () => null)
      return
    }
    const [header = '', ...files] = stdout.split('\n').filter(Boolean)
    const info: HudGit = {
      branch: (header.replace(/^## /, '').split('...')[0] ?? '').replace(/^No commits yet on /, ''),
      changed: files.length,
      ahead: Number(/ahead (\d+)/.exec(header)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(header)?.[1] ?? 0),
      files: files.slice(0, 6).map(f => `${f.slice(0, 2).trim() || '?'} ${f.slice(3).split('/').pop()}`),
    }
    await update($, git, () => info)
  } catch {
    await update($, git, () => null)
  } finally {
    isGitRefreshing = false
  }
}

async function refreshAgents($: EngineInterface) {
  try {
    const [now, listed, prev] = await Promise.all([$.clock.now(), $.agent.list(), read($, agents)])
    const known = new Map((prev.list ?? []).filter(x => x.id !== undefined).map(x => [x.id, x]))
    const list = listed.map((a): HudAgent => {
      const was = known.get(a.id)
      const isRunning = a.status === 'running'
      return {
        id: a.id,
        type: a.type,
        description: a.description,
        status: a.status,
        parentId: a.parentId ?? null,
        seenAt: was?.seenAt ?? now,
        // First seen already stopped: never watched it run, so it's settled, not waiting
        endedAt: isRunning ? null : was ? (was.endedAt ?? now) : now - SETTLE_MS,
        tools: was?.tools ?? 0,
        lastTool: was?.lastTool ?? null,
      }
    })
    // A write redraws the band, so only write what moved
    const changed =
      list.length !== (prev.list ?? []).length ||
      list.some(a => {
        const was = known.get(a.id)
        return !was || was.status !== a.status || was.parentId !== a.parentId || was.description !== a.description
      })
    if (changed) await update($, agents, () => ({ running: list.filter(x => x.status === 'running').length, list }))
    await syncHeartbeat($)
  } catch {}
}

// Running or recently finished agents, plus the ancestors that hold them in the tree
function visibleAgents(list: HudAgent[], now: number): HudAgent[] {
  const byId = new Map(list.map(a => [a.id, a]))
  const keep = new Set<string>()
  for (const a of list) {
    if (a.endedAt !== null && now - a.endedAt > LINGER_MS) continue
    for (let x: HudAgent | undefined = a; x && !keep.has(x.id); x = x.parentId ? byId.get(x.parentId) : undefined) keep.add(x.id)
  }
  return list.filter(a => keep.has(a.id))
}

// One heartbeat drives every clock on the band: it runs while a turn is live or an agent is
// on the tree, redraws once a second, and re-reads agent statuses every third beat.
// (Two timers out of phase redrew twice a second, which flickered.)
let heartbeat: { cancel: () => void } | null = null
let beats = 0

async function syncHeartbeat($: EngineInterface) {
  const [now, t, a, cp] = await Promise.all([$.clock.now(), read($, turn), read($, agents), read($, checkpoint)])
  const hasAgents = visibleAgents(a.list ?? [], now).length > 0
  const isCheckpointing = cp.status === 'running' || (cp.endedAt !== null && now - cp.endedAt < CHECKPOINT_SHOW_MS)
  const isNeeded = t.startedAt !== null || hasAgents || isCheckpointing
  if (isNeeded && heartbeat === null) {
    beats = 0
    heartbeat = $.clock.every(1000, async () => {
      beats++
      if (beats % 3 === 0 && (await hasVisibleAgents($))) await refreshAgents($)
      else if (beats % 3 === 0) await syncHeartbeat($)
      $.ui.invalidate('ui.render')
    })
  } else if (!isNeeded && heartbeat !== null) {
    heartbeat.cancel()
    heartbeat = null
    $.ui.invalidate('ui.render')
  }
}

async function hasVisibleAgents($: EngineInterface) {
  const [now, a] = await Promise.all([$.clock.now(), read($, agents)])
  return visibleAgents(a.list ?? [], now).length > 0
}

// Fork the session's own transcript into a standalone handoff doc under ~/<checkpoint dir>/.
// A fork, not a spawned agent: it answers over the full conversation (served from the prompt
// cache), where a fresh agent would start blank.
async function runCheckpoint($: EngineInterface) {
  if ((await read($, checkpoint)).status === 'running') return
  const startedAt = await $.clock.now()
  await update($, checkpoint, (): HudCheckpoint => ({ status: 'running', startedAt, endedAt: null, path: null, error: null }))
  await syncHeartbeat($)
  try {
    const [created, home, cwd, id, model, g] = await Promise.all([
      timestamp($, startedAt),
      $.env.get('HOME'),
      $.session.cwd(),
      $.session.id(),
      $.session.model().catch(() => 'unknown'),
      read($, git),
    ])
    const reply = await $.model.fork({ prompt: CHECKPOINT_PROMPT })
    if (!reply.isAnswered) throw new Error(reply.reason)
    const project = (cwd.split('/').filter(Boolean).pop() ?? 'session').replace(/[^\w.-]+/g, '-')
    const file = `${created.stamp}-${project}-${id.slice(0, 8)}.md`
    const path = `${home ?? '~'}/${config.checkpointDir}/${file}`
    const header = [
      '---',
      `created: ${created.iso}`,
      `session: ${id}`,
      `cwd: ${cwd}`,
      g ? `branch: ${g.branch}` : null,
      `model: ${model}`,
      '---',
      '',
    ].filter(x => x !== null).join('\n')
    await $.fs.write(path, header + reply.text.trim() + '\n')
    const endedAt = await $.clock.now()
    await update($, checkpoint, (): HudCheckpoint => ({ status: 'saved', startedAt, endedAt, path, error: null }))
    $.ui.toast(`checkpoint saved: ${path}`)
    $.ui.log(`checkpoint saved → ${path}`, { to: 'transcript' })
  } catch (err) {
    const endedAt = await $.clock.now()
    const error = err instanceof Error ? err.message : String(err)
    await update($, checkpoint, (): HudCheckpoint => ({ status: 'failed', startedAt, endedAt, path: null, error }))
    $.ui.toast(`checkpoint failed: ${error}`)
    $.ui.log(`checkpoint failed: ${error}`, { to: 'transcript' })
  }
  await syncHeartbeat($)
}

const unlisted = new Set<string>()

// Credit a subagent's tool call to its row; an id the list hasn't shown yet is looked up once
// (the engine's own forks carry ids no list names)
async function noteAgentTool($: EngineInterface, id: string, tool: string) {
  const list = (await read($, agents)).list ?? []
  if (list.some(x => x.id === id)) {
    await update($, agents, a => ({
      ...a,
      list: (a.list ?? []).map(x => (x.id === id ? { ...x, tools: x.tools + 1, lastTool: tool } : x)),
    }))
  } else if (!unlisted.has(id)) {
    unlisted.add(id)
    await refreshAgents($)
  }
}


// ---- formatting ----

// A checkpoint's file-name stamp and header time, in the zone the settings name.
// Local time comes from the system's date, so it follows the machine's own zone rules.
async function timestamp($: EngineInterface, ms: number): Promise<{ stamp: string; iso: string }> {
  if (config.timezone === 'us-eastern') return eastern(ms)
  if (config.timezone === 'local') {
    try {
      const { exitCode, stdout } = await $.process.run(['/bin/date', '+%Y-%m-%dT%H:%M:%S%z'], { timeoutMs: 2_000 })
      const m = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)$/.exec(stdout.trim())
      if (exitCode === 0 && m && m[1] && m[2] && m[3]) {
        return { stamp: m[1].slice(0, 16).replace(/[T:]/g, '-'), iso: `${m[1]}${m[2]}:${m[3]}` }
      }
    } catch {}
  }
  const wall = new Date(ms).toISOString().slice(0, 19)
  return { stamp: wall.slice(0, 16).replace(/[T:]/g, '-'), iso: `${wall}Z` }
}

// US Eastern wall-clock time (EDT from the second Sunday of March, EST from the first Sunday
// of November), computed by rule so it doesn't lean on the runtime's time-zone data
function eastern(ms: number): { stamp: string; iso: string } {
  const year = new Date(ms).getUTCFullYear()
  const nthSunday = (month: number, n: number) => {
    const firstDay = new Date(Date.UTC(year, month, 1)).getUTCDay()
    return 1 + ((7 - firstDay) % 7) + (n - 1) * 7
  }
  const dstStart = Date.UTC(year, 2, nthSunday(2, 2), 7) // 2:00 EST
  const dstEnd = Date.UTC(year, 10, nthSunday(10, 1), 6) // 2:00 EDT
  const offset = ms >= dstStart && ms < dstEnd ? -4 : -5
  const wall = new Date(ms + offset * 3_600_000).toISOString().slice(0, 19)
  return {
    stamp: wall.slice(0, 16).replace(/[T:]/g, '-'),
    iso: `${wall}-0${-offset}:00`,
  }
}

function tokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return String(n)
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`
}

function shortSkill(name: string): string {
  return name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
}

function topEntries(map: Record<string, number>, n: number): [string, number][] {
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n)
}

function barsText(values: number[]): string {
  const max = Math.max(1, ...values)
  return values.map(v => BARS[Math.min(7, Math.round((v / max) * 7))]).join('')
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// mcp__server_name__tool → tool
function shortTool(name: string): string {
  return name.replace(/^mcp__.+?__/, '')
}

export const register: Register = (on, options) => {
  config = readConfig(options)
  // rtk rows already counted, so parallel Bash calls don't claim the same row twice
  const claimed = new Set<number>()

  on('session.start', async ($, e, next) => {
    $.command.register({ name: 'hud', description: 'Save a session handoff doc: /hud checkpoint. Toggle a segment: /hud rtk | turn | git | skill | agents' })
    // A failed lookup leaves the tools unfound: their segments hide and the rest still draws
    tools = await resolveTools($).catch(() => tools)
    await Promise.all([refreshRtkAllTime($), refreshGit($), refreshAgents($)])
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const saved = (await read($, rtk)).saved
    await update($, turn, t => ({ ...t, startedAt: now, tools: 0 }))
    await update($, toolMix, m => ({ ...m, current: {} }))
    await update($, rtkTrend, r => ({ ...r, savedAtTurnStart: saved }))
    await update($, stats, s => ({ ...s, turns: s.turns + 1 }))
    await syncHeartbeat($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    await update($, turn, t => ({ ...t, tools: t.tools + 1 }))
    await update($, toolMix, m => ({ ...m, current: { ...m.current, [e.tool]: (m.current[e.tool] ?? 0) + 1 } }))
    await update($, stats, s => ({ ...s, tools: s.tools + 1 }))
    if (e.tool === 'Skill') {
      const name = e.skill
      await update($, skill, () => name)
      await update($, skillHistory, h => [name, ...h.filter(n => n !== name)].slice(0, 5))
    }
    if (e.agentId !== undefined) void noteAgentTool($, e.agentId, e.tool)
    const before = e.tool === 'Bash' ? await rtkMaxId($) : null
    const result = await next(e)

    // A background agent returns at once, so read statuses rather than count calls
    if (e.tool === 'Agent') void refreshAgents($)

    if (e.tool === 'Bash' && before !== null) {
      const rows = await rtkQuery(
        $,
        `select id, original_cmd, input_tokens, saved_tokens from commands where id > ${before} order by id`,
      )
      // Rows written during this call whose command appears in what Claude ran are this session's
      const mine = rows.filter(r => {
        const head = r.original_cmd.trim().split(/\s+/)[0]
        return !claimed.has(r.id) && head !== undefined && e.command.includes(head)
      })
      if (mine.length > 0) {
        mine.forEach(r => claimed.add(r.id))
        await update($, rtk, (s: HudRtk) => ({
          commands: s.commands + mine.length,
          input: s.input + mine.reduce((n, r) => n + r.input_tokens, 0),
          saved: s.saved + mine.reduce((n, r) => n + r.saved_tokens, 0),
        }))
        await update($, rtkTrend, t => {
          const top = { ...t.top }
          for (const r of mine) {
            const head = r.original_cmd.trim().split(/\s+/)[0] ?? '?'
            top[head] = (top[head] ?? 0) + r.saved_tokens
          }
          return { ...t, top }
        })
      }
    }
    if (EDITING_TOOLS.has(e.tool)) void refreshGit($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    // A subagent's turn ending means one may have finished
    if (e.agentId !== undefined) {
      void refreshAgents($)
      return next(e)
    }
    const saved = (await read($, rtk)).saved
    await update($, turn, t => ({ startedAt: null, tools: 0, lastMs: e.durationMs, lastTools: t.tools }))
    await update($, toolMix, m => ({ current: {}, last: m.current }))
    await update($, rtkTrend, t => ({ ...t, perTurn: [...(t.perTurn ?? []), saved - t.savedAtTurnStart].slice(-16) }))
    await Promise.all([refreshRtkAllTime($), refreshGit($), refreshAgents($)])
    return next(e)
  })

  on('command.run', { command: 'hud' }, async ($, e) => {
    if (e.args.trim() === 'checkpoint') {
      void runCheckpoint($)
      return { text: `checkpointing this session into ~/${config.checkpointDir}/` }
    }
    const arg = e.args.trim() as HudSegment
    const off = hiddenSegments(await read($, hidden))
    const describe = (s: HudSegment) => (s === 'rtk' && !isRtkReady() ? 'rtk (rtk not found)' : off.includes(s) ? `${s} (off)` : s)
    if (!SEGMENTS.includes(arg)) {
      return { text: `hud segments: ${SEGMENTS.map(describe).join(', ')}. Toggle with /hud <segment>.` }
    }
    if (arg === 'rtk' && !isRtkReady()) {
      return { text: 'rtk not found: install rtk, or set its path with /plugin configure neon-hud' }
    }
    const isOff = off.includes(arg)
    await update($, hidden, h => (h.includes(arg) ? h.filter(s => s !== arg) : [...h, arg]))
    return { text: `hud ${arg} ${isOff ? 'shown' : 'hidden'}` }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)

    const isDesktop = e.surface === 'desktop'
    const C = isDesktop ? DESK : CLI
    const off = hiddenSegments(await read($, hidden))
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = await $.clock.now()

    // A chip. Desktop: graphite, flush with the host surface. Terminal: slate, led by an accent edge.
    const pill = (id: string, accent: string, isLit: boolean, body: JSX.Element) => (
      <Box
        key={`pill-${id}`}
        backgroundColor={C.chip}
        paddingLeft={isDesktop ? 1 : 0}
        paddingRight={1}
        hover={{ scope: `hud-${id}`, backgroundColor: C.chipHover }}
      >
        {!isDesktop && <Text color={isLit ? accent : C.faint}>▌</Text>}
        {body}
      </Box>
    )
    // A console line: a fixed-width label column, a rule, then the line.
    // Every line shares the column, so swapping one in on hover doesn't shift the text.
    const consoleLine = (label: string, accent: string, body: JSX.Element) => (
      <Box flexGrow={1}>
        <Box width={8} flexShrink={0}>
          <Text color={accent} bold>{label}</Text>
        </Box>
        <Text color={C.rule}>{'│ '}</Text>
        {body}
      </Box>
    )
    const detail = (id: string, label: string, accent: string, body: JSX.Element) => (
      <Box
        key={`detail-${id}`}
        position="absolute"
        top={0}
        left={0}
        right={0}
        display="none"
        backgroundColor={C.chip}
        paddingLeft={1}
        hover={{ scope: `hud-${id}`, display: 'flex' }}
      >
        {consoleLine(label, accent, body)}
      </Box>
    )

    const left: JSX.Element[] = []
    const right: JSX.Element[] = []
    const details: JSX.Element[] = []
    let tree: JSX.Element[] = []

    // ── turn ──
    if (!off.includes('turn')) {
      const t = await read($, turn)
      const mix = await read($, toolMix)
      const isWorking = t.startedAt !== null
      if (isWorking || t.lastMs !== null) {
        const elapsed = isWorking ? now - (t.startedAt as number) : (t.lastMs as number)
        const calls = isWorking ? t.tools : t.lastTools
        left.push(
          pill('turn', C.live, isWorking,
            <Box>
              <Text color={isWorking ? C.live : C.faint}>{isWorking ? SPIN[Math.floor(elapsed / 1000) % 4] : '◷'}</Text>
              <Text color={isWorking ? C.text : C.dim} bold={isWorking}>{` ${duration(elapsed)}`}</Text>
              <Text color={C.dim}>{`  ${plural(calls, 'call')}`}</Text>
            </Box>,
          ),
        )
        const breakdown = topEntries(isWorking ? mix.current : mix.last, 6)
        details.push(
          detail('turn', isWorking ? 'LIVE' : 'LAST', isWorking ? C.live : C.dim,
            <Text color={C.text} wrap="truncate-end">
              {breakdown.length === 0 ? 'no tool calls' : breakdown.map(([k, v]) => `${shortTool(k)} ×${v}`).join('  ·  ')}
            </Text>,
          ),
        )
      }
    }

    // ── skill ──
    if (!off.includes('skill')) {
      const name = await read($, skill)
      if (name !== null) {
        const history = await read($, skillHistory)
        left.push(
          pill('skill', C.skill, true,
            <Box>
              <Text color={C.skill}>◆ </Text>
              <Text color={C.text}>{shortSkill(name)}</Text>
            </Box>,
          ),
        )
        details.push(
          detail('skill', 'SKILL', C.skill,
            <Text wrap="truncate-end">
              <Text color={C.text}>{name}</Text>
              {history.length > 1 && <Text color={C.dim}>{`   prev ${history.slice(1).map(shortSkill).join(', ')}`}</Text>}
            </Text>,
          ),
        )
      }
    }

    // ── agents ──
    if (!off.includes('agents')) {
      const a = await read($, agents)
      const visible = visibleAgents((a.list ?? []).filter(x => x.id !== undefined), now)
      const isSettled = (x: HudAgent) => x.status !== 'running' && x.endedAt !== null && now - x.endedAt >= SETTLE_MS
      const done = visible.filter(isSettled).length
      const active = visible.length - done
      if (visible.length > 0) {
        left.push(
          pill('agents', C.agents, active > 0,
            <Box>
              <Text color={active > 0 ? C.agents : C.faint}>⑂ </Text>
              <Text color={C.text} bold={active > 0}>{String(active)}</Text>
              <Text color={C.dim}>{' running'}</Text>
              {done > 0 && <Text color={C.dim}>{`  ${done} done`}</Text>}
            </Box>,
          ),
        )

        // The fleet as a tree, one line per agent, children indented under the agent that spawned them
        {
          const ids = new Set(visible.map(x => x.id))
          const childrenOf = (parent: string | null) =>
            visible.filter(x => (x.parentId !== null && ids.has(x.parentId) ? x.parentId : null) === parent)
          const agentLine = (x: HudAgent, depth: number, isFirst: boolean) => {
            const isRunning = x.status === 'running'
            const isSettling = !isRunning && x.endedAt !== null && now - x.endedAt < SETTLE_MS
            const isFailed = !isRunning && !isSettling && x.status !== 'completed'
            const glyph = isRunning ? SPIN[Math.floor(now / 1000) % 4] : isSettling ? '◌' : isFailed ? '✗' : '✓'
            const glyphColor = isRunning ? C.agents : isSettling ? C.dim : isFailed ? C.red : C.green
            const state = isRunning ? (x.lastTool ? shortTool(x.lastTool) : '') : isSettling ? 'waiting' : x.status
            // Fixed-width, right-aligned stat columns: a number growing a digit can't shove the line
            const stat = (key: string, width: number, text: string, color: string) => (
              <Box key={key} width={width} flexShrink={0} justifyContent="flex-end">
                <Text color={color} wrap="truncate-end">{text}</Text>
              </Box>
            )
            return (
              <Box key={`agent-${x.id}`} paddingLeft={1}>
                {consoleLine(isFirst ? 'AGENTS' : '', C.agents,
                  <Box flexGrow={1}>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="truncate-end">
                        {depth > 0 && <Text color={C.faint}>{`${'   '.repeat(depth - 1)} └ `}</Text>}
                        <Text color={glyphColor}>{`${glyph} `}</Text>
                        <Text color={isRunning ? C.text : C.dim} bold={isRunning}>{x.type}</Text>
                        <Text color={C.dim}>{`  ${x.description}`}</Text>
                      </Text>
                    </Box>
                    {stat('t', 9, duration((x.endedAt ?? now) - x.seenAt), C.faint)}
                    {stat('c', 10, plural(x.tools, 'call'), C.faint)}
                    {stat('s', 14, state, isRunning ? C.dim : C.faint)}
                  </Box>,
                )}
              </Box>
            )
          }
          const lines: JSX.Element[] = []
          const walk = (parent: string | null, depth: number) => {
            for (const x of childrenOf(parent)) {
              lines.push(agentLine(x, depth, lines.length === 0))
              walk(x.id, depth + 1)
            }
          }
          walk(null, 0)
          tree = lines
        }
      }
    }

    // ── checkpoint ──
    {
      const cp = await read($, checkpoint)
      const isRunning = cp.status === 'running'
      const isReporting = !isRunning && cp.endedAt !== null && now - cp.endedAt < CHECKPOINT_SHOW_MS
      const shown = isRunning ? 'running' : isReporting ? cp.status : 'idle'
      const label =
        shown === 'running' ? `${SPIN[Math.floor(now / 1000) % 4]} checkpointing ${duration(now - (cp.startedAt ?? now))}`
        : shown === 'saved' ? '✓ checkpoint saved'
        : shown === 'failed' ? '✗ checkpoint failed'
        : '⟲ checkpoint'
      const accent = shown === 'failed' ? C.red : shown === 'saved' ? C.green : C.mark
      right.push(
        pill('checkpoint', accent, shown !== 'idle',
          // The terminal reports clicks only in fullscreen; elsewhere ctrl+x tab focuses the band,
          // then c (drawn as "c: ⟲ checkpoint") or Enter presses it
          <Button
            key="checkpoint"
            plain
            hotkey="c"
            label={label}
            dimColor={shown === 'idle'}
            hover={{ scope: 'hud-checkpoint', color: accent }}
            onPress={() => void runCheckpoint($)}
          />,
        ),
      )
      details.push(
        detail('checkpoint', 'CHKPT', accent,
          <Text color={C.text} wrap="truncate-end">
            {shown === 'running' ? 'forking the session into a handoff doc…'
              : shown === 'saved' && cp.path ? cp.path
              : shown === 'failed' ? `failed: ${cp.error ?? 'unknown error'}`
              : `fork this session into a standalone handoff doc → ~/${config.checkpointDir}/   (ctrl+x tab, then c)`}
          </Text>,
        ),
      )
    }

    // ── git ──
    if (!off.includes('git')) {
      const g = await read($, git)
      if (g !== null) {
        const isDirty = g.changed > 0
        right.push(
          pill('git', isDirty ? C.amber : C.green, true,
            <Box>
              <Text color={isDesktop ? (isDirty ? C.amber : C.green) : C.dim}>⎇ </Text>
              <Text color={C.text}>{g.branch}</Text>
              <Text color={isDirty ? C.amber : isDesktop ? C.faint : C.dim}>{isDirty ? ` ±${g.changed}` : ' ✓'}</Text>
              {g.ahead > 0 && <Text color={C.green}>{` ↑${g.ahead}`}</Text>}
              {g.behind > 0 && <Text color={C.red}>{` ↓${g.behind}`}</Text>}
            </Box>,
          ),
        )
        const files = g.files ?? []
        details.push(
          detail('git', 'GIT', isDirty ? C.amber : C.green,
            <Text color={C.text} wrap="truncate-end">
              {files.length === 0 ? 'working tree clean' : files.join('  ·  ') + (g.changed > files.length ? `  · +${g.changed - files.length} more` : '')}
            </Text>,
          ),
        )
      }
    }

    // ── rtk ──
    if (!off.includes('rtk')) {
      const s = await read($, rtk)
      const trend = await read($, rtkTrend)
      const allTime = await read($, rtkAllTime)
      const pct = s.input > 0 ? Math.round((s.saved / s.input) * 100) : 0
      const series = (trend.perTurn ?? []).slice(-8)
      const isActive = s.commands > 0
      right.push(
        pill('rtk', C.green, isActive,
          <Box>
            <Text color={isActive || !isDesktop ? C.green : C.faint}>↯ </Text>
            <Text color={isActive || !isDesktop ? C.text : C.dim} bold={isActive || !isDesktop}>{tokens(s.saved)}</Text>
            {series.length >= 2 && <Text color={C.green}>{` ${barsText(series)}`}</Text>}
            {(isActive || !isDesktop) && <Text color={C.dim}>{` ${pct}%`}</Text>}
          </Box>,
        ),
      )
      const top = topEntries(trend.top ?? {}, 3)
      details.push(
        detail('rtk', 'RTK', C.green,
          <Text wrap="truncate-end">
            <Text color={C.text}>{`${tokens(s.saved)} saved of ${tokens(s.input)} over ${plural(s.commands, 'cmd')}`}</Text>
            {top.length > 0 && <Text color={C.dim}>{`   top ${top.map(([k, v]) => `${k} ${tokens(v)}`).join(' · ')}`}</Text>}
            {allTime !== null && <Text color={C.dim}>{`   all-time ${tokens(allTime)}`}</Text>}
          </Text>,
        ),
      )
    }

    if (left.length + right.length === 0) return next(e)

    const row = (
      <Box key="row" justifyContent="space-between" flexWrap="wrap" columnGap={2}>
        <Box columnGap={1} flexWrap="wrap">{left}</Box>
        <Box columnGap={1} flexWrap="wrap">{right}</Box>
      </Box>
    )
    if (!isDesktop) {
      return tree.length > 0 ? (
        <Box flexDirection="column">
          {row}
          <Box key="tree" flexDirection="column">{tree}</Box>
        </Box>
      ) : (
        row
      )
    }

    // Desktop: the agent tree, then a console row; at rest it reads the session, a hovered chip swaps in its detail
    const st = await read($, stats)
    const usage = await $.session.usage().catch(() => null)
    const uptime = usage ? duration(now - usage.startedAt) : null
    return (
      <Box flexDirection="column">
        {row}
        {tree.length > 0 && (
          <Box key="tree" flexDirection="column">
            {tree}
          </Box>
        )}
        <Box key="console" position="relative" height={1} overflow="hidden" paddingLeft={1}>
          {consoleLine('SESSION', C.faint,
            <Text color={C.dim} wrap="truncate-end">
              {[uptime && `up ${uptime}`, plural(st.turns, 'turn'), plural(st.tools, 'tool call')].filter(Boolean).join('  ·  ')}
            </Text>,
          )}
          {details}
        </Box>
      </Box>
    )
  })
}
