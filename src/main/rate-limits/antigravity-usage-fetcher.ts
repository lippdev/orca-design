import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'

const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
const LOOPBACK_HOST = '127.0.0.1'
const REQUEST_TIMEOUT_MS = 2_500
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080

export const ANTIGRAVITY_USAGE_UNAVAILABLE =
  'Antigravity usage is not available. Start agy so Orca can read its quota.'

export type AntigravityLanguageServerEndpoint = {
  pid: number
  httpPort: number | null
  httpsPort: number | null
}

export type AntigravityUsageFetchDeps = {
  endpoint?: AntigravityLanguageServerEndpoint | null
  postQuota?: (url: string) => Promise<unknown>
  now?: () => number
}

type Cadence = 'session' | 'weekly'
type CadenceWindow = RateLimitWindow & { cadence: Cadence }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function unavailable(now: number): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: now,
    error: ANTIGRAVITY_USAGE_UNAVAILABLE,
    status: 'unavailable',
    usageMetadata: { source: 'cli', failureKind: 'cli-unavailable' }
  }
}

export function parseAntigravityLanguageServerLog(
  logHead: string
): AntigravityLanguageServerEndpoint | null {
  const pid = Number(/Starting language server process with pid (\d+)/.exec(logHead)?.[1])
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  let httpPort: number | null = null
  let httpsPort: number | null = null
  const portPattern = /listening on random port at (\d+) for (HTTPS|HTTP)\b/g
  for (const match of logHead.matchAll(portPattern)) {
    const port = Number(match[1])
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      continue
    }
    if (match[2] === 'HTTP') {
      httpPort ??= port
    } else {
      httpsPort ??= port
    }
  }
  if (httpPort === null && httpsPort === null) {
    return null
  }
  return { pid, httpPort, httpsPort }
}

function windowFromBucket(raw: unknown): CadenceWindow | null {
  if (!isRecord(raw) || raw.disabled === true) {
    return null
  }
  const remaining = raw.remainingFraction
  if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
    return null
  }
  const id = typeof raw.bucketId === 'string' ? raw.bucketId : ''
  const name = typeof raw.displayName === 'string' ? raw.displayName : id
  const text = `${id} ${name}`.toLowerCase()
  const cadence: Cadence | null =
    text.includes('weekly') || text.includes('7d') || text.includes('7-day')
      ? 'weekly'
      : text.includes('5h') || text.includes('five hour') || text.includes('five-hour')
        ? 'session'
        : null
  if (!cadence) {
    return null
  }
  const resetTime = typeof raw.resetTime === 'string' ? Date.parse(raw.resetTime) : Number.NaN
  return {
    cadence,
    usedPercent: Math.min(100, Math.max(0, Math.round((1 - remaining) * 100))),
    windowMinutes: cadence === 'weekly' ? WEEKLY_WINDOW_MINUTES : SESSION_WINDOW_MINUTES,
    resetsAt: Number.isNaN(resetTime) ? null : resetTime,
    resetDescription: null
  }
}

function tightest(windows: CadenceWindow[], cadence: Cadence): RateLimitWindow | null {
  const matches = windows.filter((window) => window.cadence === cadence)
  if (matches.length === 0) {
    return null
  }
  const chosen = matches.reduce((worst, window) =>
    window.usedPercent > worst.usedPercent ? window : worst
  )
  return {
    usedPercent: chosen.usedPercent,
    windowMinutes: chosen.windowMinutes,
    resetsAt: chosen.resetsAt,
    resetDescription: chosen.resetDescription
  }
}

export function mapAntigravityQuotaSummary(data: unknown): ProviderRateLimits | null {
  if (!isRecord(data)) {
    return null
  }
  const response = isRecord(data.response) ? data.response : null
  const groups = Array.isArray(response?.groups) ? response.groups : null
  if (!groups) {
    return null
  }
  const windows: CadenceWindow[] = []
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.buckets)) {
      continue
    }
    for (const raw of group.buckets) {
      const window = windowFromBucket(raw)
      if (window) {
        windows.push(window)
      }
    }
  }
  const session = tightest(windows, 'session')
  const weekly = tightest(windows, 'weekly')
  if (!session && !weekly) {
    return null
  }
  return {
    provider: 'antigravity',
    session,
    weekly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', lastSuccessfulSource: 'cli' }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM')
  }
}

function discoverCurrentEndpoint(): AntigravityLanguageServerEndpoint | null {
  const logDir = path.join(homedir(), '.gemini', 'antigravity-cli', 'log')
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return null
  }
  names = names
    .filter((name) => name.startsWith('cli-') && name.endsWith('.log'))
    .sort()
    .toReversed()
    .slice(0, 12)
  for (const name of names) {
    try {
      const fd = openSync(path.join(logDir, name), 'r')
      try {
        const buffer = Buffer.alloc(8_192)
        const bytesRead = readSync(fd, buffer, 0, 8_192, 0)
        const endpoint = parseAntigravityLanguageServerLog(
          buffer.subarray(0, bytesRead).toString('utf8')
        )
        if (endpoint && isProcessAlive(endpoint.pid)) {
          return endpoint
        }
      } finally {
        closeSync(fd)
      }
    } catch {
      continue
    }
  }
  return null
}

function isLoopbackHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname === LOOPBACK_HOST
  } catch {
    return false
  }
}

function postLoopbackQuota(url: string): Promise<unknown> {
  if (!isLoopbackHttpUrl(url)) {
    return Promise.resolve(null)
  }
  const parsed = new URL(url)
  const requestOptions: https.RequestOptions = {
    protocol: parsed.protocol,
    hostname: LOOPBACK_HOST,
    port: parsed.port,
    path: `${parsed.pathname}${parsed.search}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Connect-Protocol-Version': '1'
    },
    timeout: REQUEST_TIMEOUT_MS
  }
  if (parsed.protocol === 'https:') {
    // Why: Agy presents a self-signed cert on 127.0.0.1 only.
    requestOptions.rejectUnauthorized = false
  }
  const transport = parsed.protocol === 'https:' ? https : http
  return new Promise((resolve) => {
    const request = transport.request(requestOptions, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      })
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) {
          resolve(null)
          return
        }
        try {
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          resolve(body)
        } catch {
          resolve(null)
        }
      })
      response.on('error', () => resolve(null))
    })
    request.on('timeout', () => {
      request.destroy()
      resolve(null)
    })
    request.on('error', () => resolve(null))
    request.end('{"forceRefresh":true}')
  })
}

async function probeQuota(
  endpoint: AntigravityLanguageServerEndpoint,
  postQuota: (url: string) => Promise<unknown>,
  now: () => number
): Promise<ProviderRateLimits> {
  const urls: string[] = []
  if (endpoint.httpPort !== null) {
    urls.push(`http://${LOOPBACK_HOST}:${endpoint.httpPort}${QUOTA_PATH}`)
  }
  if (endpoint.httpsPort !== null) {
    urls.push(`https://${LOOPBACK_HOST}:${endpoint.httpsPort}${QUOTA_PATH}`)
  }
  for (const url of urls) {
    let json: unknown
    try {
      json = await postQuota(url)
    } catch {
      json = null
    }
    const mapped = json === null ? null : mapAntigravityQuotaSummary(json)
    if (mapped) {
      return mapped
    }
  }
  return unavailable(now())
}

export function fetchAntigravityRateLimits(
  deps: AntigravityUsageFetchDeps = {}
): Promise<ProviderRateLimits> {
  const now = deps.now ?? Date.now
  const endpoint = deps.endpoint !== undefined ? deps.endpoint : discoverCurrentEndpoint()
  if (!endpoint) {
    return Promise.resolve(unavailable(now()))
  }
  return probeQuota(endpoint, deps.postQuota ?? postLoopbackQuota, now)
}
