import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const HISTORY_KEEP_MS = 14 * DAY
const SAMPLE_EVERY_MS = 5 * MINUTE
const HISTORY_CAP = 4000
const TRANSCRIPT_WINDOW_MS = 8 * DAY
const FETCH_EVERY_MS = MINUTE
const BACKOFF_MS = 5 * MINUTE
const REQUEST_TIMEOUT_MS = 20_000
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude."
const TOKEN_KEY = 'claudeToken'
const TOKEN_PREFIX = 'sk-ant-'

const projectsDir = () => join(homedir(), '.claude', 'projects')
const transcriptCache = new Map()

let lastFetchAt = 0
let retryAt = 0
let lastGood = null

function validToken(value) {
  return typeof value === 'string' && value.startsWith(TOKEN_PREFIX) && value.length >= 40 && !/\s/.test(value)
}

function readWindow(headers, name) {
  const utilization = Number.parseFloat(headers.get(`anthropic-ratelimit-unified-${name}-utilization`))
  const reset = Number.parseInt(headers.get(`anthropic-ratelimit-unified-${name}-reset`), 10)
  if (!Number.isFinite(utilization)) {
    return null
  }
  return {
    percent: Math.min(100, Math.max(0, Math.round(utilization * 1000) / 10)),
    resetsAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : null
  }
}

async function requestUsage(token) {
  const response = await fetch(MESSAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: 'hi' }]
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  })
  const fiveHour = readWindow(response.headers, '5h')
  const sevenDay = readWindow(response.headers, '7d')
  if (fiveHour || sevenDay) {
    const rejected = response.headers.get('anthropic-ratelimit-unified-status') === 'rejected'
    const claim = response.headers.get('anthropic-ratelimit-unified-representative-claim')
    return {
      usage: {
        ok: true,
        fiveHour,
        sevenDay,
        limitedBy: rejected && (claim === 'five_hour' || claim === 'seven_day') ? claim : null,
        checkedAt: new Date().toISOString()
      }
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { error: 'signed-out' }
  }
  if (response.status === 429) {
    return { error: 'rate-limited', backoffMs: BACKOFF_MS }
  }
  return { error: 'unavailable' }
}

async function readUsage(orca, force) {
  const now = Date.now()
  if (!force && lastGood && now - lastFetchAt < FETCH_EVERY_MS) {
    return lastGood
  }
  if (!force && now < retryAt) {
    return lastGood ? { ...lastGood, error: 'rate-limited' } : { ok: false, reason: 'rate-limited' }
  }
  lastFetchAt = now
  const token = await orca.secrets.get(TOKEN_KEY)
  if (!token) {
    return { ok: false, reason: 'no-token' }
  }
  try {
    const result = await requestUsage(token)
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
  orca.panels.handle('token.save', async (input) => {
    const token = typeof input?.token === 'string' ? input.token.replace(/\s+/g, '') : ''
    if (!validToken(token)) {
      return { ok: false, reason: 'invalid-token' }
    }
    await orca.secrets.set(TOKEN_KEY, token)
    lastGood = null
    lastFetchAt = 0
    retryAt = 0
    return { ok: true }
  })

  orca.panels.handle('token.clear', async () => {
    await orca.secrets.delete(TOKEN_KEY)
    lastGood = null
    lastFetchAt = 0
    retryAt = 0
    return { ok: true }
  })

  orca.panels.handle('dashboard.read', async (input) => {
    const usage = await readUsage(orca, input?.force === true)
    const history = await recordHistory(orca, usage)
    const activity = await readActivity()
    return { usage, history, ...activity, generatedAt: Date.now() }
  })
}
