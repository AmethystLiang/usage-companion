import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const HISTORY_KEEP_MS = 14 * DAY
const SAMPLE_EVERY_MS = 5 * MINUTE
const HISTORY_CAP = 4000
const TRANSCRIPT_WINDOW_MS = 8 * DAY

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const KEYCHAIN_SERVICE = 'Claude Code-credentials'
const FETCH_EVERY_MS = MINUTE
const BACKOFF_MS = 5 * MINUTE
const REQUEST_TIMEOUT_MS = 10_000
const projectsDir = () => join(homedir(), '.claude', 'projects')

const transcriptCache = new Map()

let lastFetchAt = 0
let retryAt = 0
let lastGood = null

function keychainAccount() {
  let user
  try {
    user = process.env.USER || process.env.USERNAME || userInfo().username
  } catch {
    return 'claude-code-user'
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

function credentialsFrom(raw) {
  try {
    const oauth = JSON.parse(raw)?.claudeAiOauth
    const token = oauth?.accessToken
    if (typeof token !== 'string' || !token) {
      return null
    }
    return { token, expiresAt: typeof oauth.expiresAt === 'number' ? oauth.expiresAt : null }
  } catch {
    return null
  }
}

async function readKeychainToken() {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', keychainAccount(), '-w'],
      { timeout: 5_000 }
    )
    return credentialsFrom(stdout)
  } catch {
    return null
  }
}

async function readCredentials() {
  const fromKeychain = process.platform === 'darwin' ? await readKeychainToken() : null
  if (fromKeychain) {
    return fromKeychain
  }
  try {
    return credentialsFrom(await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

function toIso(value) {
  if (value === undefined || value === null || value === '') {
    return null
  }
  let time
  if (typeof value === 'number' || /^\d+(\.\d+)?$/.test(String(value))) {
    const number = Number(value)
    time = number > 1e10 ? number : number * 1000
  } else {
    time = Date.parse(value)
  }
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

function windowFrom(raw) {
  if (!raw) {
    return null
  }
  const percent =
    typeof raw.utilization === 'number'
      ? raw.utilization
      : typeof raw.used_percentage === 'number'
        ? raw.used_percentage
        : null
  if (percent === null) {
    return null
  }
  return { percent: Math.min(100, Math.max(0, percent)), resetsAt: toIso(raw.resets_at) }
}

async function requestUsage(token) {
  const response = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code/2.1.0'
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  if (response.status === 401 || response.status === 403) {
    return { error: 'signed-out' }
  }
  if (response.status === 429) {
    const seconds = Number(response.headers.get('retry-after'))
    return { error: 'rate-limited', backoffMs: seconds > 0 ? seconds * 1000 : BACKOFF_MS }
  }
  if (!response.ok) {
    return { error: 'unavailable' }
  }
  const data = await response.json()
  const fiveHour = windowFrom(data.five_hour)
  const sevenDay = windowFrom(data.seven_day)
  const limitedBy =
    fiveHour?.percent >= 100 ? 'five_hour' : sevenDay?.percent >= 100 ? 'seven_day' : null
  return { usage: { ok: true, fiveHour, sevenDay, limitedBy, checkedAt: new Date().toISOString() } }
}

async function readUsage(force) {
  const now = Date.now()
  if (!force && lastGood && now - lastFetchAt < FETCH_EVERY_MS) {
    return lastGood
  }
  if (!force && now < retryAt) {
    return lastGood ? { ...lastGood, error: 'rate-limited' } : { ok: false, reason: 'rate-limited' }
  }
  lastFetchAt = now
  const credentials = await readCredentials()
  if (!credentials) {
    return { ok: false, reason: 'no-token' }
  }
  if (credentials.expiresAt !== null && credentials.expiresAt <= now) {
    return lastGood ? { ...lastGood, error: 'signed-out' } : { ok: false, reason: 'signed-out' }
  }
  try {
    const result = await requestUsage(credentials.token)
    if (result.error) {
      if (result.error === 'rate-limited') {
        retryAt = now + result.backoffMs
      }
      return lastGood ? { ...lastGood, error: result.error } : { ok: false, reason: result.error }
    }
    lastGood = result.usage
    return lastGood
  } catch {
    return lastGood ? { ...lastGood, error: 'unavailable' } : { ok: false, reason: 'unavailable' }
  }
}

async function recordHistory(orca, usage) {
  if (!usage.ok || !usage.sevenDay) {
    return (await orca.storage.get('history')) ?? []
  }
  const now = Date.now()
  const history = ((await orca.storage.get('history')) ?? []).filter((sample) => now - sample.t < HISTORY_KEEP_MS)
  const last = history[history.length - 1]
  const sample = { t: now, p: usage.sevenDay.percent, r: usage.sevenDay.resetsAt }
  const unchanged = last && last.p === sample.p && last.r === sample.r
  if (!unchanged || now - last.t >= SAMPLE_EVERY_MS) {
    history.push(sample)
  }
  const kept = history.slice(-HISTORY_CAP)
  await orca.storage.set('history', kept)
  return kept
}

async function findTranscripts(dir, since, found) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await findTranscripts(path, since, found)
    } else if (entry.name.endsWith('.jsonl')) {
      const info = await stat(path)
      if (info.mtimeMs >= since) {
        found.push({ path, mtime: info.mtimeMs })
      }
    }
  }
  return found
}

function dayKey(time) {
  const date = new Date(time)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

async function scanTranscript(file) {
  const cached = transcriptCache.get(file.path)
  if (cached && cached.mtime === file.mtime) {
    return cached.data
  }
  const data = { skills: [], tokens: {} }
  const seenMessages = new Set()
  const seenSkillCalls = new Set()
  const lines = createInterface({ input: createReadStream(file.path, 'utf8'), crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line) {
      continue
    }
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    const time = Date.parse(row.timestamp)
    const message = row.message
    if (!Number.isFinite(time) || row.type !== 'assistant' || !message) {
      continue
    }
    if (message.usage && message.id && !seenMessages.has(message.id)) {
      seenMessages.add(message.id)
      const amount = (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0)
      const key = dayKey(time)
      data.tokens[key] = (data.tokens[key] ?? 0) + amount
    }
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
        if (block.id && seenSkillCalls.has(block.id)) {
          continue
        }
        if (block.id) {
          seenSkillCalls.add(block.id)
        }
        data.skills.push({ name: block.input.skill, t: time })
      }
    }
  }
  transcriptCache.set(file.path, { mtime: file.mtime, data })
  return data
}

async function readActivity() {
  const since = Date.now() - TRANSCRIPT_WINDOW_MS
  const files = await findTranscripts(projectsDir(), since, [])
  const scanned = await Promise.all(files.map((file) => scanTranscript(file).catch(() => null)))
  const weekAgo = Date.now() - 7 * DAY
  const skills = new Map()
  const tokensByDay = {}
  for (const data of scanned) {
    if (!data) {
      continue
    }
    for (const call of data.skills) {
      if (call.t < weekAgo) {
        continue
      }
      const entry = skills.get(call.name) ?? { name: call.name, count: 0, lastUsed: 0 }
      entry.count += 1
      entry.lastUsed = Math.max(entry.lastUsed, call.t)
      skills.set(call.name, entry)
    }
    for (const [key, amount] of Object.entries(data.tokens)) {
      tokensByDay[key] = (tokensByDay[key] ?? 0) + amount
    }
  }
  const days = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = dayKey(Date.now() - offset * DAY)
    days.push({ day: key, tokens: tokensByDay[key] ?? 0 })
  }
  return {
    skills: [...skills.values()].sort((a, b) => b.count - a.count).slice(0, 15),
    tokensByDay: days
  }
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default function activate(orca) {
  orca.panels.handle('dashboard.read', async (input) => {
    const usage = await readUsage(input?.force === true)
    const history = await recordHistory(orca, usage)
    const activity = await readActivity()
    return { usage, history, ...activity, generatedAt: Date.now() }
  })
}
