# Usage Companion

An Orca panel for your Claude usage: the 5-hour and weekly limits with a progress bar and the time
each one resets, your pace through the week, daily token use and the skills you used.

Install it in Orca with the Git URL `https://github.com/renanluiz/usage-companion`.

## Connecting your account

Run `claude setup-token` in a terminal, copy the token it prints, and paste it into the panel.
The token is stored in Orca's encrypted secrets for this plugin. You can remove it from the panel.

## Where the data comes from

- **Limits:** the worker sends one tiny request (1 output token) to Claude's messages API with your
  token and reads the usage headers, the same numbers Claude Code uses. This spends a very small
  amount of your usage on each refresh, about once a minute while the panel is open.
- **Tokens and skills:** read from your local Claude Code transcripts in `~/.claude/projects`. Only
  counts and skill names are kept, never message content.
