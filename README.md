# recent-sessions

A Claude mod for the Claude desktop app (Code tab). It docks a panel beside the chat that lists your most recently active sessions, so you don't have to search the sidebar for them.

- **25 sessions** by default; **Show 10** / **Show 25** switches the length.
- **The session you're in** is listed in bold.
- **Click a session's title** to switch to it.
- **The switch at the left of each row** (blue `━●` = counted). Click it to close the session out of the list (gray `●━`). A closed session comes back on its own as soon as it shows new activity, or by hand under **Show closed**, which lists the most recently closed first. Closing happens in every panel on the machine at once, within about 15 seconds.
- **The dot** says what state each session is in:

| Dot | Meaning |
|---|---|
| purple | running |
| yellow | running, and stopped on a question to you or a plan waiting for approval |
| orange | agents working: its own turn has ended, but background agents it started are still at work |
| green | your move: finished, and its last reply asks you something or offers labelled options |
| red | its last run ended in an error |
| none | idle, nothing waiting |

Scheduled-task runs are left out of the list.

## Install

You need the Claude desktop app on a **Mac** (clicking a session opens it with the macOS `open` command), and a terminal where `claude --version` prints a version (Claude Code).

1. **Install it for your user**, so it loads in every session. In a terminal:

   ```bash
   claude plugin install recent-sessions --marketplace teloscientist-hub/claude-recent-sessions --scope user
   ```

   Or, at the prompt of a Claude Code session in a terminal: `/plugin install recent-sessions --marketplace teloscientist-hub/claude-recent-sessions`, then `y` to add the marketplace.

2. **Check it:**

   ```bash
   claude plugin list
   ```

   It should show `recent-sessions@recent-sessions`, `Scope: user`, `Status: ✔ enabled`.

3. **Open it.** Start a new session in the desktop app: the **Recent sessions** panel opens beside the chat. In a session that was already open, type `/reload-plugins`. If you close the panel, `/recent-sessions` opens it again.

### From a downloaded copy instead

Put this folder somewhere it can stay, outside Dropbox or iCloud (for example `~/claude-plugins/recent-sessions`; Claude reads the mod from it every time), then:

```bash
claude plugin marketplace add ~/claude-plugins/recent-sessions
```

```bash
claude plugin install recent-sessions@recent-sessions --scope user
```

## Updating

Installed from GitHub:

```bash
claude plugin update recent-sessions@recent-sessions
```

From a downloaded copy: replace the folder's contents. Either way, then type `/reload-plugins` in each open session.

## Removing

```bash
claude plugin uninstall recent-sessions@recent-sessions
```

```bash
claude plugin marketplace remove recent-sessions
```

## Where it keeps things

- **The closed list** is one file per machine: `closed.json` in the folder named by the `RECENT_SESSIONS_STATE_DIR` environment variable when it is set, else in `~/.claude/recent-sessions/`. Closing a session on one Mac does not close it on another.
- Nothing is sent anywhere. The panel only asks the desktop app for your session list, each listed session's details (to spot scheduled tasks), and the last few messages of each listed session (for the dot), and re-reads those only when a session changes.

## Limits

- The sidebar's own **blue "unread"** state can't be read by a mod, so it has no dot here.
- A session stopped on a **permission prompt** shows purple, not yellow: its transcript looks the same as a tool that is still working.
- Sessions are ordered, and their age shown, by their last real turn, read from `lastTurnEdgeAt` in the app's record of the session (`~/Library/Application Support/Claude/claude-code-sessions/`). The app's own activity time also moves when it only rewrites bookkeeping into a transcript, such as its watch on an artifact the session published, which used to lift days-old sessions to the top. A running session is placed by the app's activity time; a session with no turn time on record falls back to it. A closed session returns only on a real turn.
- Orange is read off the agents' own files under `~/.claude/projects/<folder>/<transcript>/subagents/`, found through the app's record of the session in `~/Library/Application Support/Claude/claude-code-sessions/`. An agent counts while its file is unfinished and has moved in the last 10 minutes, so one that is silent longer (a single long command) can drop to no dot until it writes again, and an agent stopped without finishing keeps orange for up to 10 minutes.
- Green is a reading of the last reply's text, so a reply that ends with a quoted question can show green wrongly.
