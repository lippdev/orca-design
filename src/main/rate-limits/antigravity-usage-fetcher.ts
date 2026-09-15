import { isAbsolute } from 'node:path'
import type {
  ProviderRateLimits,
  RateLimitBucket,
  RateLimitWindow
} from '../../shared/rate-limit-types'
import { resolveCliCommand, withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import { stripTerminalControlSequences } from './claude-pty-usage-parser'
import { cleanupHiddenRateLimitPty, registerHiddenRateLimitPty } from './hidden-pty-cleanup'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'

const PTY_TIMEOUT_MS = 45_000
const MAX_OUTPUT_LENGTH = 64 * 1024

export function stripAntigravityTerminalControlSequences(value: string): string {
  return stripTerminalControlSequences(value).replaceAll('\r', '\n')
}

type ParsedQuotaRow = {
  bucket: RateLimitBucket
  cadence: 'session' | 'weekly'
}

function parseQuotaRow(line: string): ParsedQuotaRow | null {
  const match = line
    .trim()
    .match(
      /^(.*?)\s+(Weekly Limit|Five Hour Limit|5-hour Limit)\s+Remaining\s+(\d+(?:\.\d+)?)%\s+(\S+)\s*$/
    )
  if (!match) {
    return null
  }
  const [, group, rawCadence, rawRemaining, rawReset] = match
  const remaining = Number(rawRemaining)
  const resetsAt = Date.parse(rawReset!)
  if (
    !group ||
    !Number.isFinite(remaining) ||
    remaining < 0 ||
    remaining > 100 ||
    Number.isNaN(resetsAt)
  ) {
    return null
  }
  const cadence = rawCadence === 'Weekly Limit' ? 'weekly' : 'session'
  return {
    cadence,
    bucket: {
      name: `${group} · ${cadence === 'weekly' ? 'Weekly' : '5h'}`,
      usedPercent: Math.round((100 - remaining) * 100) / 100,
      windowMinutes: cadence === 'weekly' ? 7 * 24 * 60 : 5 * 60,
      resetsAt,
      resetDescription: null
    }
  }
}

function tightest(
  rows: ParsedQuotaRow[],
  cadence: ParsedQuotaRow['cadence']
): RateLimitWindow | null {
  const candidates = rows.filter((row) => row.cadence === cadence).map((row) => row.bucket)
  if (candidates.length === 0) {
    return null
  }
  const selected = candidates.reduce((current, candidate) =>
    candidate.usedPercent > current.usedPercent ? candidate : current
  )
  const { name: _name, ...window } = selected
  return window
}

export function parseAntigravityQuotaOutput(output: string): ProviderRateLimits | null {
  const clean = stripAntigravityTerminalControlSequences(output)
  if (!clean.split('\n').some((line) => line.trim() === 'Quota:')) {
    return null
  }
  const rows = clean
    .split('\n')
    .map(parseQuotaRow)
    .filter((row): row is ParsedQuotaRow => row !== null)
  if (rows.length === 0) {
    return null
  }
  return {
    provider: 'antigravity',
    session: tightest(rows, 'session'),
    weekly: tightest(rows, 'weekly'),
    buckets: rows.map((row) => row.bucket),
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  }
}

function unavailable(error: string, status: 'error' | 'unavailable'): ProviderRateLimits {
  return {
    provider: 'antigravity',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status,
    usageMetadata: {
      source: 'cli',
      attemptedSources: ['cli'],
      failureKind: status === 'unavailable' ? 'cli-unavailable' : 'usage-unavailable'
    }
  }
}

export async function fetchAntigravityRateLimits(
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return unavailable('Antigravity usage refresh was cancelled', 'unavailable')
  }
  const command = resolveCliCommand('agy')
  if (!isAbsolute(command)) {
    return unavailable('Antigravity CLI is not installed', 'unavailable')
  }
  const pty = await import('node-pty')
  if (signal?.aborted) {
    return unavailable('Antigravity usage refresh was cancelled', 'unavailable')
  }

  return new Promise<ProviderRateLimits>((resolve) => {
    let output = ''
    let settled = false
    const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command)
    const commandArgs = ['--sandbox', '--print-timeout', '30s', '--print', '/usage']
    const spawnFile = isWindowsScript ? 'cmd.exe' : command
    const spawnArgs = isWindowsScript
      ? ['/d', '/s', '/c', `"${command}"`, ...commandArgs]
      : commandArgs
    let term: ReturnType<typeof pty.spawn>
    try {
      term = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-256color',
        cols: 160,
        rows: 60,
        cwd: resolveHiddenRateLimitPtyCwd(),
        env: withCliRuntimeOnPath(command, {
          ...process.env,
          TERM: 'xterm-256color',
          NO_COLOR: '1'
        })
      })
    } catch (error) {
      resolve(
        unavailable(
          error instanceof Error ? error.message : 'Could not start Antigravity CLI',
          'error'
        )
      )
      return
    }

    const disposables: { dispose: () => void }[] = [registerHiddenRateLimitPty(term)]
    let timeout: ReturnType<typeof setTimeout> | null = null
    const finish = (kill: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      cleanupHiddenRateLimitPty(term, disposables, { kill })
      resolve(
        parseAntigravityQuotaOutput(output) ??
          unavailable('Antigravity CLI did not return a quota report', 'error')
      )
    }
    const abort = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      cleanupHiddenRateLimitPty(term, disposables, { kill: true })
      resolve(unavailable('Antigravity usage refresh was cancelled', 'unavailable'))
    }
    if (signal) {
      signal.addEventListener('abort', abort, { once: true })
      disposables.push({ dispose: () => signal.removeEventListener('abort', abort) })
    }
    timeout = setTimeout(() => finish(true), PTY_TIMEOUT_MS)
    disposables.push(
      term.onData((data) => {
        output += data
        if (output.length > MAX_OUTPUT_LENGTH) {
          output = output.slice(-MAX_OUTPUT_LENGTH)
        }
      }),
      term.onExit(() => finish(false))
    )
  })
}
