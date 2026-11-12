# Limits Tracker

An Orca panel that shows your Claude 5-hour and 7-day usage limits, with the time each one resets.
It reads the usage Orca already keeps for your Claude account and refreshes every minute while the
panel is open.

Install it in Orca with the Git URL `https://github.com/renanluiz/limits-tracker`.

It needs an Orca account set up in `~/.config/orca-claude-accounts/accounts.json`. The panel
reads only the `usage` block of the active account.
