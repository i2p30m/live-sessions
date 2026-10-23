# live-sessions

A mod for Claude Code (the Code tab of the Claude desktop app): a pane beside the conversation that lists all your sessions and makes their state obvious at a glance.

- **Needs you**: the session asked a question, wants a plan approved, or is waiting for a tool permission.
- **Working** and **Waiting on background work**, with an expandable list of the background tasks (shells, subagents; monitors are left out, as in the app).
- **Done, not checked**: the session finished and you have not opened it since (✓ marks it as checked). Click the circle of any other session to flag it to come back to: it joins this group until you open it or press ✓.
- **Context** on each live session: a short bar and a percentage under its state icon, always in the same spot, showing how full its context window is (blue, amber from 75%, red from 90%).
- **Projects**: the other sessions grouped by project, the project you worked in most recently first, with side sessions nested under the session that started them. Pick how many sessions each project shows at the top of the pane.

Click a title to open that session. **+** next to a project opens a new, empty session in that project's folder. ↓ moves a session from the top into its project, ↑ brings it back. Nothing is archived or deleted: it only changes the pane, and a session with new activity comes back to the top on its own.

The pane opens when a session starts, or with your first message if the app did not show it then; `/live-sessions` (or `/sesje`) opens it again after you close it.

The pane's settings are shared by every session: the width you drag it to, the projects you fold and the number of sessions per project. The app itself decides which side the pane docks on and whether it pops out; the mod cannot set those.

## Language

The pane follows Claude Code's `language` setting: Polish when it is set to Polish (`"language": "polish"` in `~/.claude/settings.json`), English otherwise.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install live-sessions --marketplace i2p30m/live-sessions
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```
claude plugin install live-sessions --marketplace i2p30m/live-sessions
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `i2p30m/live-sessions`, then Add plugin.

The mod runs in sessions started after it is installed.
