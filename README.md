# Usage Companion

An Orca panel for your Claude usage: the 5-hour and weekly limits with a progress bar and the time
each one resets, your pace through the week, daily token use and the skills you used.

Install it in Orca with the Git URL `https://github.com/renanluiz/usage-companion`.

## Where the data comes from

- **Limits:** the worker reads your Claude Code login from the macOS keychain (or
  `~/.claude/.credentials.json`) and asks Claude's usage endpoint about once a minute. That is the
  same request Orca's own Claude usage uses. The token is only held in memory and sent to
  `api.anthropic.com`. It is never stored, logged or shown.
- **Tokens and skills:** read from your local Claude Code transcripts in `~/.claude/projects`. Only
  counts and skill names are kept, never message content.

The first keychain read may ask macOS for permission to let `security` read the Claude Code item.
