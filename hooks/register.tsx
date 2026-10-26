import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { RecentSession, RecentSessionsView } from '../types'

const PANE = 'recent-sessions'
const LIMIT = 25
// The shorter list the panel's button switches to.
const SHORT = 10
// Fetched past LIMIT so closed sessions leave room for the next ones.
const FETCH = 50
const POLL_MS = 15_000
// The desktop app's own session-management MCP server.
const SERVER = 'ccd_session_mgmt'
// The closed marks live in one file every copy of the mod and every session
// shares (a plugin's own store is per install): session id -> its lastActivityAt
// when it was marked closed. In $RECENT_SESSIONS_STATE_DIR when it is set,
// else in ~/.claude/recent-sessions.
const CLOSED_FILE = 'closed.json'

// The sidebar's own unread / needs-input / failed states are not exposed to
// mods. Needs-input and failed are read off each transcript's tail instead
// (list_events: its last line and its last [result] line); unread
// has no source, so an idle session with nothing standing out draws no dot.
const DOT_RUNNING = 'success'
const DOT_NEEDS_INPUT = 'warning'
const DOT_FAILED = 'error'
const DOT_YOUR_MOVE = '#a371f7'
// Seen live 2026-10-23: a session blocked on a question to the person stays
// "(running)" and its transcript ends on the unanswered call. A permission
// prompt cannot be told apart from a tool still working, so it is not counted.
const ASKING = /^\[assistant\] \(called (?:AskUserQuestion|ExitPlanMode)\)\s*$/
// "Your move": the last reply asks something (a line ending in "?") or offers
// labelled options at the start of a line, as `a1` - ... or **l1:** ...
const ASKS = /\?\s*$|^\s*(?:[-*]\s*)?[`*]*[a-z]{1,2}\d+[`*:]*\s*[-:–—]?\s/m
// The final reply often sits behind hidden messages (tool results), so read back this far.
const TAIL = 10
// The counted/closed switch at the head of each row.
const SWITCH_ON = '#2f81f7'
const SWITCH_OFF = '#8b949e'

const view = atom({ plugin: 'recent-sessions', key: 'view' } as const, {
  sessions: [],
  closed: [],
  showClosed: false,
  limit: LIMIT,
  error: null,
  fetchedAt: null,
} as RecentSessionsView)

type Row = {
  sessionId: string
  title?: string
  isRunning?: boolean
  pinned?: boolean
  group?: { name: string } | null
  lastActivityAt?: string
  link?: string
  // Only get_session reports it: the scheduled task a session runs for.
  scheduledTaskId?: string
}

// A mark: the session's lastActivityAt when it was closed, and when it was closed.
// Marks written before closedAt was kept are the bare activity string.
type Mark = string | { activity: string; closedAt: string }
type Closed = Record<string, Mark>

const activityOf = (mark: Mark): string => (typeof mark === 'string' ? mark : mark.activity)
const closedAtOf = (mark: Mark): string => (typeof mark === 'string' ? '' : mark.closedAt)

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

let closedPath: string | undefined

async function closedFile($: EngineInterface): Promise<string> {
  if (closedPath) return closedPath
  const { exitCode, stdout } = await $.process.run([
    '/bin/sh',
    '-c',
    'printf "%s\\n%s" "$RECENT_SESSIONS_STATE_DIR" "$HOME"',
  ])
  const [dir = '', home = ''] = stdout.split('\n').map(line => line.trim())
  if (exitCode !== 0 || (!dir && !home)) throw new Error('could not find a folder for the closed list')
  closedPath = `${dir || `${home}/.claude/recent-sessions`}/${CLOSED_FILE}`
  return closedPath
}

async function readClosed($: EngineInterface): Promise<Closed> {
  const path = await closedFile($)
  if (!(await $.fs.exists(path))) return {}
  // A file that does not parse throws, so a refresh never writes over it.
  const value = JSON.parse(await $.fs.read(path)) as unknown
  return value && typeof value === 'object' ? (value as Closed) : {}
}

async function writeClosed($: EngineInterface, marks: Closed): Promise<void> {
  await $.fs.write(await closedFile($), `${JSON.stringify(marks, null, 2)}\n`)
}

async function callJson($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<unknown> {
  const res = await $.mcp.call(SERVER, tool, args)
  const block = res.content.find(b => b.type === 'text') as { text?: string } | undefined
  if (res.isError || !block?.text) throw new Error(block?.text ?? 'no result')
  return JSON.parse(block.text)
}

// Transcript reads are cached per session until its activity or running state moves.
const attentionCache = new Map<string, { stamp: string; attention: RecentSession['attention'] }>()

async function readAttention($: EngineInterface, s: RecentSession): Promise<RecentSession['attention']> {
  const stamp = `${s.lastActivityAt}|${s.isRunning}`
  const hit = attentionCache.get(s.id)
  if (hit?.stamp === stamp) return hit.attention
  let attention: RecentSession['attention'] = null
  try {
    const res = await $.mcp.call(SERVER, 'list_events', { session_id: s.id, limit: TAIL })
    const text = res.content.map(b => (b.type === 'text' ? (b as { text: string }).text : '')).join('\n')
    const results = text.match(/^\[result\] .*$/gm)
    const lastResult = results?.at(-1) ?? ''
    const replies = text.split(/^\[assistant\] /m)
    const lastReply = replies.length > 1 ? (replies.at(-1) ?? '').split(/^\[result\] /m)[0] ?? '' : ''
    if (!res.isError && lastResult && !s.isRunning && !/success/i.test(lastResult)) attention = 'failed'
    const lastLine = text.trimEnd().split('\n').at(-1) ?? ''
    if (attention === null && !res.isError && s.isRunning && ASKING.test(lastLine)) attention = 'needsInput'
    if (attention === null && !res.isError && !s.isRunning && ASKS.test(lastReply)) attention = 'yourMove'
  } catch {
    // A transcript that cannot be read leaves the dot to the running state.
  }
  attentionCache.set(s.id, { stamp, attention })
  return attention
}

// Whether a session runs a scheduled task never changes, so each is looked up once.
const scheduledCache = new Map<string, boolean>()

async function isScheduled($: EngineInterface, id: string): Promise<boolean> {
  const hit = scheduledCache.get(id)
  if (hit !== undefined) return hit
  let isTask = false
  try {
    const row = (await callJson($, 'get_session', { session_id: id })) as Row
    isTask = typeof row.scheduledTaskId === 'string' && row.scheduledTaskId !== ''
  } catch {
    // Unreadable details: shown, as before.
  }
  scheduledCache.set(id, isTask)
  return isTask
}

function toSession(r: Row, isCurrent: boolean): RecentSession {
  return {
    id: r.sessionId,
    title: r.title || r.sessionId,
    isRunning: r.isRunning === true,
    isPinned: r.pinned === true,
    group: r.group?.name ?? null,
    lastActivityAt: r.lastActivityAt ?? '',
    link: r.link ?? null,
    isCurrent,
    attention: null,
  }
}

async function refresh($: EngineInterface): Promise<void> {
  try {
    // list_sessions leaves out the session it is asked from; get_session adds it back.
    const rows = (await callJson($, 'list_sessions', { limit: FETCH })) as Row[]
    const self = (await callJson($, 'get_session', { session_id: 'self' })) as Row
    scheduledCache.set(self.sessionId, typeof self.scheduledTaskId === 'string' && self.scheduledTaskId !== '')
    const all: RecentSession[] = [
      toSession(self, true),
      ...rows.filter(r => r.sessionId !== self.sessionId).map(r => toSession(r, false)),
    ].sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))

    // A closed session counts again once it runs or shows newer activity. The
    // session drawing the pane is running while it works, so only its activity counts.
    const marks = await readClosed($)
    const kept: Closed = {}
    const sessions: RecentSession[] = []
    const closed: RecentSession[] = []
    for (const s of all) {
      const mark = marks[s.id]
      // Scheduled-task runs are left out; looked up only while a row could still use them.
      if (sessions.length >= LIMIT && mark === undefined) continue
      if (await isScheduled($, s.id)) continue
      const isRestarted = (!s.isCurrent && s.isRunning) || (mark !== undefined && Date.parse(s.lastActivityAt) > Date.parse(activityOf(mark)))
      if (mark !== undefined && !isRestarted) {
        kept[s.id] = mark
        closed.push(s)
      } else if (sessions.length < LIMIT) {
        sessions.push(s)
      }
    }
    // list_events refuses the session it is asked from; its own state shows anyway.
    for (const s of sessions) if (!s.isCurrent) s.attention = await readAttention($, s)

    // Most recently closed first; marks with no close time after, by activity.
    closed.sort((a, b) => {
      const at = closedAtOf(kept[a.id]!)
      const bt = closedAtOf(kept[b.id]!)
      if (at !== bt) return bt.localeCompare(at)
      return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt)
    })

    // Marks for sessions past the fetch window are kept: they may come back.
    for (const [id, mark] of Object.entries(marks)) {
      if (!all.some(s => s.id === id)) kept[id] = mark
    }
    if (Object.keys(kept).length !== Object.keys(marks).length) await writeClosed($, kept)

    const fetchedAt = await $.clock.now()
    await update($, view, v => ({ ...v, sessions, closed, error: null, fetchedAt }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, view, v => ({ ...v, error: message }))
  }
}

// The poll. Timers end when the module reloads (/reload-plugins) or when one
// tick is refused, and nothing says so, so the pane restarts the poll itself
// whenever it has gone quiet, instead of trusting session.start to run again.
let timer: Timer | undefined
let lastTickAt = 0
let isRefreshing = false
// A refresh that hangs (an MCP call that never answers) would otherwise hold
// isRefreshing forever, which is the same freeze by another road.
const REFRESH_LIMIT_MS = 60_000

async function refreshOnce($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  let isDone = false
  try {
    // Throws only while the refresh is still running, so a finished one leaves nothing behind.
    const limit = $.clock.sleep(REFRESH_LIMIT_MS).then(() => {
      if (!isDone) throw new Error(`a refresh took longer than ${REFRESH_LIMIT_MS / 1000}s`)
    })
    await Promise.race([refresh($), limit])
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, view, v => ({ ...v, error: message }))
  } finally {
    isDone = true
    isRefreshing = false
  }
}

async function tick($: EngineInterface): Promise<void> {
  lastTickAt = await $.clock.now()
  await refreshOnce($)
}

const isQuiet = (now: number): boolean => !timer || now - lastTickAt >= POLL_MS * 3

async function ensureTicking($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  if (!isQuiet(now)) return
  timer?.cancel()
  lastTickAt = now
  timer = $.clock.every(POLL_MS, () => void tick($))
  await refreshOnce($)
}

function clockTime(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

async function markClosed($: EngineInterface, s: RecentSession): Promise<void> {
  const marks = await readClosed($)
  const closedAt = new Date(await $.clock.now()).toISOString()
  await writeClosed($, { ...marks, [s.id]: { activity: s.lastActivityAt, closedAt } })
  await refresh($)
}

async function reopen($: EngineInterface, id: string): Promise<void> {
  const marks = await readClosed($)
  delete marks[id]
  await writeClosed($, marks)
  await refresh($)
}

async function toggleLength($: EngineInterface): Promise<void> {
  await update($, view, v => ({ ...v, limit: v.limit === SHORT ? LIMIT : SHORT }))
}

async function toggleClosed($: EngineInterface): Promise<void> {
  await update($, view, v => ({ ...v, showClosed: !v.showClosed }))
}

// Hands the session's claude:// address to macOS, which switches the app to it
// the way an outside link does.
async function openSession($: EngineInterface, link: string | null): Promise<void> {
  if (!link) {
    $.ui.toast('This session has no link to open.')
    return
  }
  try {
    const { exitCode, stderr } = await $.process.run(['open', link])
    if (exitCode !== 0) $.ui.toast(`Could not open session: ${stderr.trim() || `exit ${exitCode}`}`)
  } catch (err) {
    $.ui.toast(`Could not open session: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function meta(s: RecentSession, now: number): string {
  return [s.isRunning ? 'running' : 'idle', ago(s.lastActivityAt, now), s.isPinned ? 'pinned' : null, s.group]
    .filter(Boolean)
    .join(' · ')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'recent-sessions',
      description: 'Show the 25 most recently active sessions in a side pane',
    })
    void $.ui.open({ id: PANE, title: 'Recent sessions' })
    void ensureTicking($)

    return next(e)
  })

  // Frequent events double as a heartbeat for the poll.
  on('prompt.submit', async ($, e, next) => {
    void ensureTicking($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    void ensureTicking($)
    return next(e)
  })

  on('command.run', { command: 'recent-sessions' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Recent sessions' })
    await ensureTicking($)
    await refreshOnce($)

    return { text: 'Recent sessions pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const now = await $.clock.now()
    // A drawing cannot write state, so a restart is scheduled to run just after it.
    if (isQuiet(now)) $.clock.after(0, () => void ensureTicking($))

    return (
      <Box flexDirection="column" gap={1}>
        {v.error && <Text color="#f85149">Could not list sessions: {v.error}</Text>}
        {!v.error && v.fetchedAt === null && <Text dimColor>Loading…</Text>}
        {v.fetchedAt !== null && <Text dimColor>Updated {clockTime(v.fetchedAt)}</Text>}
        {v.sessions.slice(0, v.limit).map(s => (
          <Box flexDirection="row" gap={1}>
            <Button key={`close:${s.id}`} plain onPress={() => markClosed($, s)}>
              <Text color={SWITCH_ON}>━●</Text>
            </Button>
            {/* Outside the Button: a desktop draws a Button's text in its own colour. */}
            {s.attention === 'failed' ? (
              <Text color={DOT_FAILED}>●</Text>
            ) : s.attention === 'needsInput' ? (
              <Text color={DOT_NEEDS_INPUT}>●</Text>
            ) : s.attention === 'yourMove' ? (
              <Text color={DOT_YOUR_MOVE}>●</Text>
            ) : s.isRunning ? (
              <Text color={DOT_RUNNING}>●</Text>
            ) : (
              <Text> </Text>
            )}
            {s.isCurrent ? (
              <Text bold>
                {s.title} <Text dimColor>this session · {meta(s, now)}</Text>
              </Text>
            ) : (
              <Button key={s.id} plain onPress={() => openSession($, s.link)}>
                {s.title} <Text dimColor>{meta(s, now)}</Text>
              </Button>
            )}
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          <Button key="refresh" onPress={() => refreshOnce($)}>Refresh</Button>
          <Button key="length" dimColor onPress={() => toggleLength($)}>
            {v.limit === SHORT ? `Show ${LIMIT}` : `Show ${SHORT}`}
          </Button>
          {v.closed.length > 0 && (
            <Button key="toggle-closed" dimColor onPress={() => toggleClosed($)}>
              {v.showClosed ? 'Hide closed' : `Show closed (${v.closed.length})`}
            </Button>
          )}
        </Box>
        {v.showClosed &&
          v.closed.map(s => (
            <Box flexDirection="row" gap={1}>
              <Button key={`reopen:${s.id}`} plain onPress={() => reopen($, s.id)}>
                <Text color={SWITCH_OFF}>●━</Text>
              </Button>
              <Button key={s.id} plain dimColor onPress={() => openSession($, s.link)}>
                {s.title} <Text dimColor>closed · {ago(s.lastActivityAt, now)}</Text>
              </Button>
            </Box>
          ))}
      </Box>
    )
  })
}
