// Reads the usage Orca already keeps for each Claude account. Only the `usage` block is read;
// tokens and account identity stay in the file.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const accountsFile = () => join(homedir(), '.config', 'orca-claude-accounts', 'accounts.json')

function windowOf(usage, key) {
  const window = usage?.[key]
  if (!window || typeof window.percent !== 'number') {
    return null
  }
  return { percent: window.percent, resetsAt: window.resetsAt ?? null, status: window.status ?? null }
}

async function readLimits() {
  let accounts
  try {
    accounts = JSON.parse(await readFile(accountsFile(), 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: false, reason: 'no-accounts' }
    }
    return { ok: false, reason: 'unreadable' }
  }
  const list = Array.isArray(accounts?.accounts) ? accounts.accounts : []
  const account = list.find((item) => item.id === accounts.active) ?? list[0]
  if (!account?.usage) {
    return { ok: false, reason: 'no-usage' }
  }
  const { usage } = account
  return {
    ok: true,
    fiveHour: windowOf(usage, 'fiveHour'),
    sevenDay: windowOf(usage, 'sevenDay'),
    limitedBy: usage.limitedBy ?? null,
    checkedAt: usage.at ?? null
  }
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default function activate(orca) {
  orca.panels.handle('limits.read', () => readLimits())
}
