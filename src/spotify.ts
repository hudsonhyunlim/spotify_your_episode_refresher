/**
 * Minimal Spotify Web API client built on native `fetch`. No SDK, and nothing in
 * `dependencies` — the hourly workflow runs without an `npm ci` step, which halves
 * its billable minutes (see README).
 */
import { asPaging } from './types.ts'
import type { Paging } from './types.ts'

// Overridable so the sync can be exercised end to end against a local mock; both
// default to the real service and are not set in normal operation.
const ACCOUNTS_URL = process.env.SPOTIFY_ACCOUNTS_URL ?? 'https://accounts.spotify.com/api/token'
const API_BASE = process.env.SPOTIFY_API_BASE ?? 'https://api.spotify.com/v1'

const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? 5)
/** Refuse to sit on a cron runner for longer than this when rate limited. */
const MAX_RETRY_AFTER_SECONDS = Number(process.env.MAX_RETRY_AFTER ?? 600)

/**
 * Since June 2026 refresh tokens expire six months after the original
 * authorization, and refreshing does not reset that clock. There is no automated
 * recovery: re-authorizing needs a browser and a human.
 */
export class TokenExpiredError extends Error {}

export class ApiError extends Error {
  status: number
  /** Seconds Spotify asked us to wait, when it said so. */
  retryAfter: number | undefined
  constructor(status: number, message: string, retryAfter?: number) {
    super(message)
    this.status = status
    this.retryAfter = retryAfter
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface Credentials {
  clientId: string
  clientSecret: string
  refreshToken: string
}

export async function getAccessToken(credentials: Credentials): Promise<string> {
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    'base64',
  )
  const response = await fetch(ACCOUNTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
    }),
  })

  const body: unknown = await response.json().catch(() => ({}))
  const payload = (body ?? {}) as Record<string, unknown>

  if (!response.ok) {
    if (payload.error === 'invalid_grant') {
      throw new TokenExpiredError(
        'Spotify rejected the refresh token (invalid_grant).\n' +
          'Refresh tokens expire six months after the original authorization, and\n' +
          'refreshing does not extend them. To recover, on your own machine run:\n\n' +
          '  SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth\n\n' +
          'then update the secret:\n\n' +
          '  gh secret set SPOTIFY_REFRESH_TOKEN\n',
      )
    }
    throw new ApiError(
      response.status,
      `Token refresh failed (${response.status}): ${JSON.stringify(payload)}`,
    )
  }

  if (typeof payload.refresh_token === 'string' && payload.refresh_token !== credentials.refreshToken) {
    // Rotation is rare but documented. Missing it means the job dies at some
    // unpredictable future point, so make it impossible to overlook in the log.
    console.warn(
      '\n' +
        '='.repeat(72) +
        '\n!! Spotify returned a NEW refresh token. Update the secret or this job\n' +
        '!! will eventually start failing:\n!!\n' +
        `!!   gh secret set SPOTIFY_REFRESH_TOKEN --body '${payload.refresh_token}'\n` +
        '='.repeat(72) +
        '\n',
    )
  }

  if (typeof payload.access_token !== 'string') {
    throw new Error('Token refresh succeeded but returned no access_token')
  }
  return payload.access_token
}

export interface Client {
  api: <T>(method: string, path: string, query?: Record<string, string | number>) => Promise<T>
  paginate: <T>(path: string, query?: Record<string, string | number>) => AsyncGenerator<T>
  callCount: () => number
}

export function createClient(accessToken: string): Client {
  let calls = 0

  async function request<T>(
    method: string,
    url: string,
    query?: Record<string, string | number>,
  ): Promise<T> {
    const target = new URL(url.startsWith('http') ? url : `${API_BASE}${url}`)
    for (const [key, value] of Object.entries(query ?? {})) {
      target.searchParams.set(key, String(value))
    }

    for (let attempt = 0; ; attempt++) {
      calls++
      let response: Response
      try {
        response = await fetch(target, {
          method,
          headers: { Authorization: `Bearer ${accessToken}` },
        })
      } catch (cause) {
        if (attempt >= MAX_RETRIES) throw cause
        await sleep(1000 * 2 ** attempt)
        continue
      }

      if (response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? 5)
        if (!Number.isFinite(retryAfter) || retryAfter > MAX_RETRY_AFTER_SECONDS) {
          throw new ApiError(
            429,
            `Rate limited on ${method} ${target.pathname} with Retry-After ${retryAfter}s, ` +
              `which exceeds MAX_RETRY_AFTER (${MAX_RETRY_AFTER_SECONDS}s).`,
            retryAfter,
          )
        }
        if (attempt >= MAX_RETRIES) {
          throw new ApiError(429, `Still rate limited after ${MAX_RETRIES} retries`)
        }
        console.warn(`Rate limited; waiting ${retryAfter}s (attempt ${attempt + 1})`)
        await sleep((retryAfter + 1) * 1000)
        continue
      }

      if (response.status >= 500) {
        if (attempt >= MAX_RETRIES) {
          throw new ApiError(response.status, `${method} ${target.pathname} failed repeatedly`)
        }
        await sleep(1000 * 2 ** attempt)
        continue
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new ApiError(
          response.status,
          `${method} ${target.pathname} → ${response.status} ${text.slice(0, 400)}`,
        )
      }

      if (response.status === 204 || response.headers.get('content-length') === '0') {
        return undefined as T
      }
      const text = await response.text()
      if (text.length === 0) return undefined as T
      return JSON.parse(text) as T
    }
  }

  async function* paginate<T>(
    path: string,
    query?: Record<string, string | number>,
  ): AsyncGenerator<T> {
    let url: string | null = path
    let first = true
    while (url !== null) {
      const page: Paging<T> = asPaging<T>(
        await request<unknown>('GET', url, first ? query : undefined),
        path,
      )
      first = false
      for (const item of page.items) yield item
      url = page.next
    }
  }

  return {
    api: <T>(method: string, path: string, query?: Record<string, string | number>) =>
      request<T>(method, path, query),
    paginate,
    callCount: () => calls,
  }
}
