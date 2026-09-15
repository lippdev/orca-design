import { describe, expect, it } from 'vitest'
import { parseAntigravityQuotaOutput } from './antigravity-usage-fetcher'

const SAMPLE = `Quota:
Gemini Models Weekly Limit Remaining 94% 2026-09-12T01:47:23Z
Gemini Models Five Hour Limit Remaining 78% 2026-09-10T06:12:31Z
Claude and GPT models Weekly Limit Remaining 100% 2026-09-17T01:47:23Z
Claude and GPT models Five Hour Limit Remaining 81.5% 2026-09-10T08:13:44Z`

describe('parseAntigravityQuotaOutput', () => {
  it('turns the official CLI remaining quota into used windows', () => {
    const result = parseAntigravityQuotaOutput(SAMPLE)
    expect(result).toMatchObject({
      provider: 'antigravity',
      status: 'ok',
      session: { usedPercent: 22, windowMinutes: 300 },
      weekly: { usedPercent: 6, windowMinutes: 10_080 }
    })
    expect(result?.buckets).toEqual([
      expect.objectContaining({ name: 'Gemini Models · Weekly', usedPercent: 6 }),
      expect.objectContaining({ name: 'Gemini Models · 5h', usedPercent: 22 }),
      expect.objectContaining({ name: 'Claude and GPT models · Weekly', usedPercent: 0 }),
      expect.objectContaining({ name: 'Claude and GPT models · 5h', usedPercent: 18.5 })
    ])
  })

  it('accepts terminal control sequences and CR line endings', () => {
    const result = parseAntigravityQuotaOutput(`\u001b[2J${SAMPLE.replaceAll('\n', '\r\n')}`)
    expect(result?.buckets).toHaveLength(4)
  })

  it('refuses malformed quota instead of inventing zero usage', () => {
    expect(parseAntigravityQuotaOutput('Sign in to continue')).toBeNull()
    expect(
      parseAntigravityQuotaOutput(
        'Quota:\nGemini Models Five Hour Limit Remaining 120% 2026-09-10T06:12:31Z'
      )
    ).toBeNull()
    expect(
      parseAntigravityQuotaOutput('Quota:\nGemini Models Five Hour Limit Remaining 80% not-a-date')
    ).toBeNull()
  })
})
