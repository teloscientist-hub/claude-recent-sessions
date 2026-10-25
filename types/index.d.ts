export type RecentSession = {
  id: string
  title: string
  isRunning: boolean
  isPinned: boolean
  group: string | null
  lastActivityAt: string
  link: string | null
  // The session this pane is drawn in.
  isCurrent: boolean
  // Read from the tail of its transcript; null when nothing stands out.
  attention: 'needsInput' | 'failed' | 'yourMove' | null
}

export type RecentSessionsView = {
  sessions: RecentSession[]
  // Sessions marked closed that have had no activity since.
  closed: RecentSession[]
  showClosed: boolean
  // Rows shown: SHORT or LIMIT.
  limit: number
  error: string | null
  fetchedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'recent-sessions': { view: RecentSessionsView }
  }
}
