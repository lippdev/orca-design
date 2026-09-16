import { describe, expect, it } from 'vitest'
import {
  ANTIGRAVITY_USAGE_UNAVAILABLE,
  fetchAntigravityRateLimits,
  mapAntigravityQuotaSummary,
  parseAntigravityLanguageServerLog
} from './antigravity-usage-fetcher'

const GROUPED_SUMMARY = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            remainingFraction: 0.8,
            resetTime: '2026-09-20T12:00:00Z'
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            remainingFraction: 0.4,
            resetTime: '2026-09-16T01:00:00Z'
          }
        ]
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: 'claude-gpt-weekly',
            displayName: 'Weekly Limit Remaining',
            remainingFraction: 0.95,
            resetTime: '2026-09-20T12:00:00Z'
          },
          {
            bucketId: 'claude-gpt-5h',
            displayName: 'Five Hour Limit Remaining',
            remainingFraction: 0.7,
            resetTime: '2026-09-16T01:00:00Z'
          }
        ]
      }
    ]
  }
}

const LIVE_LOG = [
  'Starting language server process with pid 4242',
  'listening on random port at 4312 for HTTP',
  'listening on random port at 4313 for HTTPS (gRPC)'
].join('\n')

describe('parseAntigravityLanguageServerLog', () => {
  it('reads pid and both loopback ports from an Agy startup banner', () => {
    expect(parseAntigravityLanguageServerLog(LIVE_LOG)).toEqual({
      pid: 4242,
      httpPort: 4312,
      httpsPort: 4313
    })
  })
})

describe('mapAntigravityQuotaSummary', () => {
  it('maps native grouped remainingFraction buckets onto session and weekly', () => {
    const limits = mapAntigravityQuotaSummary(GROUPED_SUMMARY)
    expect(limits?.provider).toBe('antigravity')
    expect(limits?.status).toBe('ok')
    expect(limits?.session?.usedPercent).toBe(60)
    expect(limits?.session?.windowMinutes).toBe(300)
    expect(limits?.weekly?.usedPercent).toBe(20)
    expect(limits?.weekly?.windowMinutes).toBe(10_080)
  })

  it('ignores disabled buckets', () => {
    const limits = mapAntigravityQuotaSummary({
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              {
                bucketId: 'gemini-5h',
                displayName: 'Five Hour Limit Remaining',
                remainingFraction: 0.1,
                disabled: true
              },
              {
                bucketId: 'gemini-weekly',
                displayName: 'Weekly Limit Remaining',
                remainingFraction: 0.5
              }
            ]
          }
        ]
      }
    })
    expect(limits?.session).toBeNull()
    expect(limits?.weekly?.usedPercent).toBe(50)
  })
})

describe('fetchAntigravityRateLimits', () => {
  const endpoint = {
    pid: 4242,
    httpPort: 4312,
    httpsPort: 4313
  }

  it('POSTs the quota RPC to the current live loopback endpoint and maps the summary', async () => {
    const posted: string[] = []
    const limits = await fetchAntigravityRateLimits({
      endpoint,
      postQuota: async (url) => {
        posted.push(url)
        expect(url.startsWith('http://127.0.0.1:')).toBe(true)
        return GROUPED_SUMMARY
      }
    })
    expect(posted).toEqual([
      'http://127.0.0.1:4312/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
    ])
    expect(limits.status).toBe('ok')
    expect(limits.session?.usedPercent).toBe(60)
  })

  it('reports unavailable when no local LanguageServer is running', async () => {
    const limits = await fetchAntigravityRateLimits({
      endpoint: null,
      postQuota: async () => {
        throw new Error('must not probe loopback when no LanguageServer is running')
      }
    })
    expect(limits.status).toBe('unavailable')
    expect(limits.provider).toBe('antigravity')
    expect(limits.error).toBe(ANTIGRAVITY_USAGE_UNAVAILABLE)
    expect(limits.session).toBeNull()
    expect(limits.weekly).toBeNull()
  })

  it('falls back to the HTTPS loopback port when HTTP does not answer', async () => {
    const posted: string[] = []
    const limits = await fetchAntigravityRateLimits({
      endpoint,
      postQuota: async (url) => {
        posted.push(url)
        if (url.startsWith('http://')) {
          return null
        }
        return GROUPED_SUMMARY
      }
    })
    expect(posted).toEqual([
      'http://127.0.0.1:4312/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary',
      'https://127.0.0.1:4313/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary'
    ])
    expect(limits.status).toBe('ok')
  })
})
