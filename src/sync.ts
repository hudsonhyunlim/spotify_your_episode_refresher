/**
 * Hourly entry point. Reconciles Your Episodes against the newest unplayed episodes
 * from every followed show, and is safe to run repeatedly — each run recomputes the
 * desired state from scratch, so a missed cron costs nothing.
 */
import { createClient, getAccessToken, ApiError, TokenExpiredError } from './spotify.ts'
import type { Client, Credentials } from './spotify.ts'
import { readState, writeState } from './state.ts'
import type { ChangePlan } from './select.ts'
import {
  URIS_PER_REQUEST,
  chunk,
  normalizeReleaseDate,
  planChanges,
  planReorder,
  selectEpisodes,
  toStateEntries,
} from './select.ts'
import { asEpisode } from './types.ts'
import type { Candidate, SavedEpisode, SavedShow, SimplifiedEpisode, UserProfile } from './types.ts'

const config = {
  maxEpisodes: Number(process.env.MAX_EPISODES ?? 20),
  episodesPerShow: Number(process.env.EPISODES_PER_SHOW ?? 5),
  dryRun: process.env.DRY_RUN === '1',
  reorder: process.env.REORDER !== '0',
  verifyResumePoints: process.env.VERIFY_RESUME_POINTS !== '0',
  stateFile: process.env.STATE_FILE ?? 'state.json',
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

function toCandidate(episode: SimplifiedEpisode, showId: string, showName: string): Candidate {
  return {
    uri: episode.uri,
    id: episode.id,
    name: episode.name,
    showId,
    showName,
    releaseDate: normalizeReleaseDate(episode.release_date, episode.release_date_precision),
    fullyPlayed: episode.resume_point?.fully_played === true,
  }
}

/**
 * `GET /me/shows` is the one endpoint with no substitute — there is no other way to
 * ask which shows the user follows. Fail here with an explanation rather than
 * somewhere deeper with a bare 403.
 */
async function preflight(client: Client): Promise<string | undefined> {
  const me = await client.api<UserProfile>('GET', '/me')
  try {
    await client.api('GET', '/me/shows', { limit: 1 })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      throw new Error(
        'GET /me/shows is not available to this app.\n' +
          'The February 2026 Development Mode migration removed a number of endpoints; ' +
          'if this one is now among them there is no way to enumerate followed shows, ' +
          'and the show IDs would have to be configured explicitly instead.\n' +
          `Original error: ${error.message}`,
      )
    }
    throw error
  }
  return me.country
}

async function collectCandidates(
  client: Client,
  market: string | undefined,
): Promise<Candidate[]> {
  const shows: SavedShow[] = []
  for await (const saved of client.paginate<SavedShow>('/me/shows', { limit: 50 })) {
    shows.push(saved)
  }
  console.log(`Followed shows: ${shows.length}`)

  const candidates: Candidate[] = []
  for (const saved of shows) {
    const query: Record<string, string | number> = { limit: config.episodesPerShow }
    if (market !== undefined) query.market = market

    // Batch lookups were removed for Development Mode apps, so this is one call per show.
    const page = await client.api<{ items: unknown[] }>(
      'GET',
      `/shows/${saved.show.id}/episodes`,
      query,
    )
    for (const item of page.items ?? []) {
      if (item === null) continue
      candidates.push(toCandidate(asEpisode(item, 'show episodes'), saved.show.id, saved.show.name))
    }
  }
  console.log(`Candidate episodes: ${candidates.length}`)
  return candidates
}

/**
 * `GET /shows/{id}/episodes` is known to return stale `resume_point` values, while
 * `GET /episodes/{id}` is accurate. Re-check only the episodes whose played state can
 * change an outcome: the current shortlist, plus everything already tracked.
 */
async function verifyResumePoints(
  client: Client,
  candidates: Candidate[],
  urisToCheck: ReadonlySet<string>,
  market: string | undefined,
): Promise<Candidate[]> {
  const query: Record<string, string | number> = {}
  if (market !== undefined) query.market = market

  const corrected = new Map<string, boolean>()
  for (const uri of urisToCheck) {
    const id = uri.split(':').pop()
    if (id === undefined || id === '') continue
    try {
      const episode = asEpisode(await client.api('GET', `/episodes/${id}`, query), 'episode')
      corrected.set(uri, episode.resume_point?.fully_played === true)
    } catch (error) {
      // An episode can go unavailable in the user's market between calls. Leave the
      // listing's value in place rather than failing the whole run over one episode.
      console.warn(`Could not verify ${uri}: ${(error as Error).message}`)
    }
  }

  return candidates.map((candidate) => {
    const fullyPlayed = corrected.get(candidate.uri)
    return fullyPlayed === undefined ? candidate : { ...candidate, fullyPlayed }
  })
}

async function savedUris(client: Client, uris: readonly string[]): Promise<Set<string>> {
  const saved = new Set<string>()
  for (const batch of chunk(uris, URIS_PER_REQUEST)) {
    const results = await client.api<boolean[]>('GET', '/me/library/contains', {
      uris: batch.join(','),
    })
    batch.forEach((uri, index) => {
      if (results[index] === true) saved.add(uri)
    })
  }
  return saved
}

/** `uris` is a query parameter with an empty body — not a JSON payload. */
async function libraryWrite(
  client: Client,
  method: 'PUT' | 'DELETE',
  uris: readonly string[],
): Promise<void> {
  for (const batch of chunk(uris, URIS_PER_REQUEST)) {
    await client.api(method, '/me/library', { uris: batch.join(',') })
  }
}

async function currentLibraryOrder(client: Client): Promise<string[] | undefined> {
  try {
    const order: string[] = []
    for await (const saved of client.paginate<SavedEpisode>('/me/episodes', { limit: 50 })) {
      if (saved.episode?.uri !== undefined) order.push(saved.episode.uri)
    }
    return order
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      console.warn('GET /me/episodes unavailable; skipping the re-order pass this run.')
      return undefined
    }
    throw error
  }
}

/**
 * On a real run the re-order pass reads the library after the adds have landed. A
 * dry run performs no writes, so project them here instead — otherwise it would
 * always report a re-order that the real run would not need.
 */
function projectOrder(order: readonly string[], plan: ChangePlan): string[] {
  const removed = new Set(plan.toRemove)
  let next = order.filter((uri) => !removed.has(uri))
  for (const candidate of plan.toAdd) {
    next = next.filter((uri) => uri !== candidate.uri)
    next.unshift(candidate.uri)
  }
  return next
}

function describe(candidate: Candidate): string {
  return `  ${candidate.releaseDate}  ${candidate.showName} — ${candidate.name}`
}

async function main(): Promise<void> {
  const credentials: Credentials = {
    clientId: requireEnv('SPOTIFY_CLIENT_ID'),
    clientSecret: requireEnv('SPOTIFY_CLIENT_SECRET'),
    refreshToken: requireEnv('SPOTIFY_REFRESH_TOKEN'),
  }

  if (config.dryRun) console.log('DRY RUN — nothing will be added, removed or written.\n')

  const client = createClient(await getAccessToken(credentials))
  const market = await preflight(client)
  const state = await readState(config.stateFile)

  let candidates = await collectCandidates(client, market)
  let selected = selectEpisodes({ candidates, maxEpisodes: config.maxEpisodes })

  if (config.verifyResumePoints) {
    const toCheck = new Set<string>([
      ...selected.map((candidate) => candidate.uri),
      ...state.added.map((entry) => entry.uri),
    ])
    candidates = await verifyResumePoints(client, candidates, toCheck, market)
    selected = selectEpisodes({ candidates, maxEpisodes: config.maxEpisodes })
  }

  const interesting = [
    ...new Set([...selected.map((c) => c.uri), ...state.added.map((e) => e.uri)]),
  ]
  const saved = await savedUris(client, interesting)
  const plan = planChanges({ selected, state, saved })

  console.log(`\nTop ${selected.length} unplayed episodes:`)
  for (const candidate of selected) console.log(describe(candidate))

  console.log(`\nAdd (${plan.toAdd.length}):`)
  for (const candidate of plan.toAdd) console.log(describe(candidate))
  console.log(`Remove (${plan.toRemove.length}):`)
  for (const uri of plan.toRemove) console.log(`  ${uri}`)
  if (plan.manual.length > 0) {
    console.log(`Manual saves left untouched (${plan.manual.length}):`)
    for (const uri of plan.manual) console.log(`  ${uri}`)
  }

  if (!config.dryRun) {
    if (plan.toRemove.length > 0) await libraryWrite(client, 'DELETE', plan.toRemove)
    if (plan.toAdd.length > 0) {
      await libraryWrite(
        client,
        'PUT',
        plan.toAdd.map((candidate) => candidate.uri),
      )
    }
  }

  let reordered = false
  if (config.reorder && plan.tracked.length > 0) {
    const fetched = await currentLibraryOrder(client)
    if (fetched !== undefined) {
      const order = config.dryRun ? projectOrder(fetched, plan) : fetched
      const reorder = planReorder({ tracked: plan.tracked, currentOrder: order })
      if (reorder.addUris.length > 0) {
        reordered = true
        console.log(`\nRe-ordering ${reorder.addUris.length} script-added episodes.`)
        if (!config.dryRun) {
          await libraryWrite(client, 'DELETE', reorder.removeUris)
          await libraryWrite(client, 'PUT', reorder.addUris)
        }
      }
    }
  }

  const now = new Date().toISOString()
  if (!config.dryRun) {
    await writeState(config.stateFile, {
      version: state.version,
      updatedAt: now,
      added: toStateEntries(plan.tracked, state, now),
    })
  }

  console.log(
    `\nadded ${plan.toAdd.length}, removed ${plan.toRemove.length}, ` +
      `reordered ${reordered ? 'yes' : 'no'}, tracked ${plan.tracked.length}, ` +
      `manual ${plan.manual.length}, api calls ${client.callCount()}` +
      (config.dryRun ? ' (dry run)' : ''),
  )
}

main().catch((error: unknown) => {
  if (error instanceof TokenExpiredError) {
    console.error(`\n${error.message}`)
    process.exit(2)
  }
  console.error(error)
  process.exit(1)
})
