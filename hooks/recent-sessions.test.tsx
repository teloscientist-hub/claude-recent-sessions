import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'recent-sessions',
  component: 'Pane',
  requestId: 'recent-sessions',
  props: {
    title: 'Recent sessions',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// Others, newest first, a minute apart from 14:00 down.
const others = Array.from({ length: 30 }, (_, i) => ({
  sessionId: `local_${i}`,
  title: `Session ${i}`,
  isRunning: false,
  pinned: i === 1,
  group: i === 2 ? { id: 'g', name: 'Corpus' } : null,
  lastActivityAt: new Date(Date.parse('2026-10-23T14:00:00.000Z') - i * 60_000).toISOString(),
  link: `claude://claude.ai/epitaxy/local_${i}`,
}))

// This session: active between local_2 and local_3.
let self = {
  sessionId: 'local_self',
  title: 'This one',
  isRunning: true,
  group: null,
  lastActivityAt: '2026-10-23T13:57:30.000Z',
  link: 'claude://claude.ai/epitaxy/local_self',
}

const CLOSED = '/state/recent-sessions/closed.json'

// The file system has no bottom in the kit: a map stands for the shared file,
// and every session's panel would read and write the same one.
function stubFiles(on: any, files: Map<string, string>) {
  on('fs.exists', (_: unknown, e: { path: string }) => ({ value: files.has(e.path) }))
  on('fs.read', (_: unknown, e: { path: string }) =>
    files.has(e.path) ? { value: files.get(e.path) } : { deny: 'missing' },
  )
  on('fs.write', (_: unknown, e: { path: string; text: string }) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
}

function stubEngine(
  on: any,
  list: () => object[],
  isBroken = false,
  files = new Map<string, string>(),
  opened: string[][] = [],
  events: Record<string, string> = {},
  eventReads: string[] = [],
  scheduled: Set<string> = new Set(),
  detailReads: string[] = [],
  // $RECENT_SESSIONS_STATE_DIR as the session's shell sees it; '' when unset.
  stateDir = '/state/recent-sessions',
) {
  on('command.register', () => ({ value: { command: 'recent-sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ deny: 'no ticks in tests' }))
  on('clock.now', () => ({ value: Date.parse('2026-10-23T14:05:00.000Z') }))
  on('mcp.call', (_: unknown, e: { tool: string; args: { session_id?: string } }) => {
    if (isBroken) return { value: { content: [{ type: 'text', text: 'no such server' }], isError: true } }
    if (e.tool === 'list_events') {
      const id = e.args.session_id ?? ''
      eventReads.push(id)
      const text = events[id] ?? `Session "x" (idle) — showing 2 of 9 messages\n\n[result] done (success), 3 turns`
      return { value: { content: [{ type: 'text', text }], isError: false } }
    }
    if (e.tool === 'get_session' && e.args.session_id !== 'self') {
      const id = e.args.session_id ?? ''
      detailReads.push(id)
      const row = list().find(r => (r as { sessionId: string }).sessionId === id) ?? {}
      const text = JSON.stringify(scheduled.has(id) ? { ...row, scheduledTaskId: 'daily-thing' } : row)
      return { value: { content: [{ type: 'text', text }], isError: false } }
    }
    const text = JSON.stringify(e.tool === 'get_session' ? self : list())
    return { value: { content: [{ type: 'text', text }], isError: false } }
  })
  stubFiles(on, files)
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    if (e.argv[0] === '/bin/sh') return { value: { exitCode: 0, stdout: `${stateDir}\n/Users/someone`, stderr: '' } }
    opened.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
}

test('lists 25 sessions, this one included and bold, by recent activity', async ($, on) => {
  stubEngine(on, () => others.map((r, i) => ({ ...r, isRunning: i === 0 })))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    const mine = await ui.find({ type: 'Text', text: /^This one/ })
    expect(mine?.props.bold).toBe(true)
    expect(await ui.find({ type: 'Button', key: 'local_self' })).toBeUndefined()
    expect(await ui.find({ type: 'Button', key: 'close:local_self' })).toBeDefined()

    // 24 others plus this one; local_24 is the 26th and drops off.
    expect(await ui.find({ type: 'Button', key: 'local_23' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'local_24' })).toBeUndefined()

    // Dots only on running sessions (local_0 and this one), drawn outside any Button.
    const dots = await ui.findAll({ type: 'Text', text: /^●$/ })
    expect(dots).toHaveLength(2)
    expect(dots.every(d => d.props.color === 'success')).toBe(true)
    await ui.unmount()
  }
})

test('pressing a row opens that session', async ($, on) => {
  const opened: string[][] = []
  stubEngine(on, () => others, false, new Map(), opened)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'local_3' })
  await ui.unmount()
  expect(opened).toEqual([['open', 'claude://claude.ai/epitaxy/local_3']])
})

test('shows the error when the session list cannot be read', async ($, on) => {
  stubEngine(on, () => others, true)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /Could not list/ }))?.text).toContain('no such server')
  await ui.unmount()
})

test('a switched-off session leaves the 25 until it shows new activity', async ($, on) => {
  let live = others
  stubEngine(on, () => live)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'close:local_1' })
  expect(await ui.find({ type: 'Button', key: 'local_1' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'local_24' })).toBeDefined()

  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'local_1' })).toBeUndefined()

  live = others.map(r => (r.sessionId === 'local_1' ? { ...r, lastActivityAt: '2026-10-23T15:00:00.000Z' } : r))
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'local_1' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'local_24' })).toBeUndefined()
  await ui.unmount()
})

test('a switched-off session can be switched back on', async ($, on) => {
  stubEngine(on, () => others)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'close:local_2' })
  await ui.press({ key: 'toggle-closed' })
  await ui.press({ key: 'reopen:local_2' })
  expect(await ui.find({ type: 'Button', key: 'local_2' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'toggle-closed' })).toBeUndefined()
  await ui.unmount()
})

test('this session can be switched off, and returns on its next activity', async ($, on) => {
  const start = self
  stubEngine(on, () => others)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'close:local_self' })
  // Running, as the session drawing the pane is, does not bring it back.
  expect(await ui.find({ type: 'Text', text: /^This one/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'local_24' })).toBeDefined()

  self = { ...self, lastActivityAt: '2026-10-23T15:00:00.000Z' }
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /^This one/ }))?.props.bold).toBe(true)
  self = start
  await ui.unmount()
})

test('a switch flipped in any panel reaches every panel through the shared file', async ($, on) => {
  const files = new Map<string, string>()
  stubEngine(on, () => others, false, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })

  // Flipped here: written to the shared file.
  await ui.press({ key: 'close:local_4' })
  expect(Object.keys(JSON.parse(files.get(CLOSED) ?? '{}'))).toEqual(['local_4'])

  // Flipped in another session's panel: this one drops it on its next refresh.
  files.set(CLOSED, JSON.stringify({ local_4: others[4]!.lastActivityAt, local_5: others[5]!.lastActivityAt }))
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'local_5' })).toBeUndefined()

  // Switched back on elsewhere: it returns here too.
  files.set(CLOSED, JSON.stringify({ local_4: others[4]!.lastActivityAt }))
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'local_5' })).toBeDefined()
  await ui.unmount()
})

test('a shared file that does not parse is shown as an error and left alone', async ($, on) => {
  const files = new Map([[CLOSED, '{ not json']])
  stubEngine(on, () => others, false, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /Could not list/ })).toBeDefined()
  expect(files.get(CLOSED)).toBe('{ not json')
  await ui.unmount()
})

test('dots: red failed, yellow asking you now, purple your move; read once per change', async ($, on) => {
  const events = {
    local_5: 'Session "Five (draft)" (idle) — showing 2 of 9 messages\n\n[assistant] hm\n[result] done (error_during_execution), 2 turns',
    // As seen live on 2026-10-23 for a session blocked on a question.
    local_6: 'Session "Six" (running) — showing 3 of 40 messages\nPass before_uuid="c_1" to page further back.\n\n[assistant] (called AskUserQuestion)',
    local_7: 'Session "Seven" (idle) — showing 2 of 9 messages\n\n[assistant] Done.\n\n- `a1` - Ship it.\n- `a2` - Hold.\n\n— context: ~4% of 1M\n[result] done (success), 3 turns',
    local_10: 'Session "Ten" (idle) — showing 8 of 203 messages\n\n[assistant] **Two ways on.**\n\n- **l1:** Do the first thing.\n- **l2:** Do the second thing.\n\n— context: ~34% of 1M\n[result] done (success), 2 turns',
    // A finished report with no question or options: no dot.
    local_11: 'Session "Eleven" (idle) — showing 6 of 75 messages\n\n[assistant] Nothing new this run.\n\n- **Search:** 2 items found.\n[result] done (success), 7 turns',
    local_8: 'Session "Eight" (idle) — showing 2 of 9 messages\n\n[assistant] Which folder should it go in?\n[result] done (success), 1 turns',
    // A running tool is not a question: no yellow.
    local_9: 'Session "Nine" (running) — showing 2 of 9 messages\n\n[assistant] (called Bash)',
  }
  const reads: string[] = []
  const running = new Set(['local_6', 'local_9'])
  stubEngine(on, () => others.map(r => ({ ...r, isRunning: running.has(r.sessionId) })), false, new Map(), [], events, reads)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const dots = await ui.findAll({ type: 'Text', text: /^●$/ })
  expect(dots.map(d => d.props.color).sort()).toEqual(['#a371f7', '#a371f7', '#a371f7', 'error', 'success', 'success', 'warning'])
  expect(reads).not.toContain('local_self')

  // Nothing moved: no transcript is read again.
  const before = reads.length
  await ui.press({ key: 'refresh' })
  expect(reads.length).toBe(before)
  await ui.unmount()
})

test('scheduled-task sessions are left out, each looked up once', async ($, on) => {
  const reads: string[] = []
  stubEngine(on, () => others, false, new Map(), [], {}, [], new Set(['local_3', 'local_7']), reads)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'local_3' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'local_7' })).toBeUndefined()
  // Two left out, so two more come in: 14 others plus this session.
  expect(await ui.find({ type: 'Button', key: 'local_25' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'local_26' })).toBeUndefined()
  // Nothing past the 15th is looked up.
  expect(reads).not.toContain('local_27')

  const before = reads.length
  await ui.press({ key: 'refresh' })
  expect(reads.length).toBe(before)
  await ui.unmount()
})

test('the length button switches between 25 and 10 rows', async ($, on) => {
  stubEngine(on, () => others)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Button', key: 'length' }))?.text).toBe('Show 10')

  await ui.press({ key: 'length' })
  // 9 others plus this one.
  expect(await ui.find({ type: 'Button', key: 'local_8' })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'local_9' })).toBeUndefined()
  expect((await ui.find({ type: 'Button', key: 'length' }))?.text).toBe('Show 25')

  // A refresh keeps the choice.
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Button', key: 'local_9' })).toBeUndefined()

  await ui.press({ key: 'length' })
  expect(await ui.find({ type: 'Button', key: 'local_23' })).toBeDefined()
  await ui.unmount()
})

test('the closed list runs most recently closed first, old marks after', async ($, on) => {
  const at = (i: number) => others[i]!.lastActivityAt
  const files = new Map([
    [
      CLOSED,
      JSON.stringify({
        local_1: { activity: at(1), closedAt: '2026-10-24T08:00:00.000Z' },
        local_6: { activity: at(6), closedAt: '2026-10-24T09:00:00.000Z' },
        // Written before close times were kept.
        local_4: at(4),
        local_3: { activity: at(3), closedAt: '2026-10-24T07:00:00.000Z' },
      }),
    ],
  ])
  stubEngine(on, () => others, false, files)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'toggle-closed' })
  const order = (await ui.findAll({ type: 'Button' }))
    .map(b => b.key ?? '')
    .filter(k => k.startsWith('reopen:'))
  expect(order).toEqual(['reopen:local_6', 'reopen:local_1', 'reopen:local_3', 'reopen:local_4'])

  // Closing one now records when, beside its activity.
  await ui.press({ key: 'close:local_8' })
  const mark = JSON.parse(files.get(CLOSED) ?? '{}').local_8
  expect(mark).toEqual({ activity: at(8), closedAt: '2026-10-23T14:05:00.000Z' })
  await ui.unmount()
})

test('without RECENT_SESSIONS_STATE_DIR the closed list lives under ~/.claude', async ($, on) => {
  const files = new Map<string, string>()
  stubEngine(on, () => others, false, files, [], {}, [], new Set(), [], '')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /Could not list/ })).toBeUndefined()
  await ui.press({ key: 'close:local_2' })
  expect([...files.keys()]).toEqual(['/Users/someone/.claude/recent-sessions/closed.json'])
  await ui.unmount()
})
