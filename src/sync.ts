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
  mergeEverAdded,
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
  /** At most this many episodes from any one show. 0 means no cap. */
  maxPerShow: Number(process.env.MAX_PER_SHOW ?? 0),
  episodesPerShow: Number(process.env.EPISODES_PER_SHOW ?? 5),
  /** When 0, finished episodes stay in the list and age out by release date. */
  skipPlayed: process.env.SKIP_PLAYED !== '0',
  /** Treat an episode this far through as finished. 0 relies on `fully_played` alone. */
  playedThresholdPercent: Number(process.env.PLAYED_THRESHOLD_PERCENT ?? 0),
  /** One request per added URI, so Your Episodes ends up in the intended order. */
  orderedAdds: process.env.ORDERED_ADDS !== '0',
  /** Remove saved episodes this script has no record of. Destroys manual saves. */
  pruneUntracked: process.env.PRUNE_UNTRACKED === '1',
  /** Drop a selected episode whose title already appears earlier in the list. */
  dedupeByTitle: process.env.DEDUPE_BY_TITLE !== '0',
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
    durationMs: episode.duration_ms,
    resumePositionMs: episode.resume_point?.resume_position_ms ?? 0,
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

  const corrected = new Map<string, SimplifiedEpisode>()
  for (const uri of urisToCheck) {
    const id = uri.split(':').pop()
    if (id === undefined || id === '') continue
    try {
      corrected.set(uri, asEpisode(await client.api('GET', `/episodes/${id}`, query), 'episode'))
    } catch (error) {
      // An episode can go unavailable in the user's market between calls. Leave the
      // listing's value in place rather than failing the whole run over one episode.
      console.warn(`Could not verify ${uri}: ${(error as Error).message}`)
    }
  }

  return candidates.map((candidate) => {
    const episode = corrected.get(candidate.uri)
    if (episode === undefined) return candidate
    // Correct the position as well as the flag: PLAYED_THRESHOLD_PERCENT compares
    // against it, and the listing's value is the one known to be unreliable.
    return {
      ...candidate,
      fullyPlayed: episode.resume_point?.fully_played === true,
      resumePositionMs: episode.resume_point?.resume_position_ms ?? 0,
      durationMs: episode.duration_ms > 0 ? episode.duration_ms : candidate.durationMs,
    }
  })
}

/**
 * The whole of Your Episodes, in display order (most recently added first).
 *
 * This is the single source of truth for what is actually saved. Asking
 * `/me/library/contains` about a guessed list of URIs can only ever confirm the
 * episodes we already suspected, so anything that leaked into the library
 * unnoticed stays invisible — and it costs more calls than just reading the list.
 */
async function libraryOrder(client: Client): Promise<string[] | undefined> {
  try {
    const order: string[] = []
    for await (const saved of client.paginate<SavedEpisode>('/me/episodes', { limit: 50 })) {
      if (saved.episode?.uri !== undefined) order.push(saved.episode.uri)
    }
    return order
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
      console.warn('GET /me/episodes unavailable; falling back to /me/library/contains.')
      return undefined
    }
    throw error
  }
}

/** Fallback when `/me/episodes` is unavailable: can only check URIs we know about. */
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

/**
 * `uris` is a query parameter with an empty body — not a JSON payload.
 *
 * `ordered` sends one URI per request instead of batching. Your Episodes is
 * sorted by when an item was added, and a batched `PUT` appears to stamp every
 * URI in the request with the same time — so within a batch the resulting order
 * is arbitrary, which reads as random. One request per URI gives each its own
 * timestamp and makes the order deterministic. Removals don't care, so they stay
 * batched at 40 per request.
 */
async function libraryWrite(
  client: Client,
  method: 'PUT' | 'DELETE',
  uris: readonly string[],
  ordered = false,
): Promise<void> {
  if (ordered && method === 'PUT') {
    for (const uri of uris) {
      await client.api(method, '/me/library', { uris: uri })
    }
    return
  }
  for (const batch of chunk(uris, URIS_PER_REQUEST)) {
    await client.api(method, '/me/library', { uris: batch.join(',') })
  }
}

/**
 * The library order as it stands after this run's adds and removes, derived from
 * the order read before them. Saves re-reading the whole list just to check
 * whether a re-order is still needed.
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

  const selectionOptions = {
    maxEpisodes: config.maxEpisodes,
    maxPerShow: config.maxPerShow,
    skipPlayed: config.skipPlayed,
    playedThreshold: config.playedThresholdPercent / 100,
    dedupeByTitle: config.dedupeByTitle,
  }

  let candidates = await collectCandidates(client, market)
  let selected = selectEpisodes({ candidates, ...selectionOptions })

  // Verifying resume points costs one call per episode, and only matters if the
  // played state can change the outcome. With SKIP_PLAYED=0 it cannot.
  if (config.verifyResumePoints && config.skipPlayed) {
    const toCheck = new Set<string>([
      ...selected.map((candidate) => candidate.uri),
      ...state.added.map((entry) => entry.uri),
    ])
    candidates = await verifyResumePoints(client, candidates, toCheck, market)
    selected = selectEpisodes({ candidates, ...selectionOptions })
  } else if (!config.skipPlayed) {
    console.log('SKIP_PLAYED=0: keeping the newest episodes regardless of played state.')
  }

  // One read gives membership, display order and any strays, all at once.
  const order = await libraryOrder(client)
  const saved =
    order !== undefined
      ? new Set(order)
      : await savedUris(client, [
          ...new Set([
            ...selected.map((c) => c.uri),
            ...state.added.map((e) => e.uri),
            ...(state.everAdded ?? []),
          ]),
        ])
  const plan = planChanges({ selected, state, saved, pruneUntracked: config.pruneUntracked })

  console.log(`Your Episodes currently holds ${saved.size} episodes.`)

  const showCount = new Set(selected.map((candidate) => candidate.showId)).size
  const heading = config.skipPlayed ? 'unplayed episodes' : 'episodes'
  console.log(
    `\nTop ${selected.length} ${heading} from ${showCount} shows` +
      (config.maxPerShow > 0 ? ` (max ${config.maxPerShow} per show)` : '') +
      ':',
  )
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
    // Record what is about to be added *before* adding it. If the run dies
    // between the write and the final state save, the next run still recognises
    // these as its own and can clear them, instead of mistaking them for manual
    // saves and leaving them stranded.
    if (plan.toAdd.length > 0) {
      await writeState(config.stateFile, {
        ...state,
        everAdded: mergeEverAdded(
          state.everAdded,
          plan.toAdd.map((candidate) => candidate.uri),
        ),
      })
    }
    if (plan.toRemove.length > 0) await libraryWrite(client, 'DELETE', plan.toRemove)
    if (plan.toAdd.length > 0) {
      await libraryWrite(
        client,
        'PUT',
        plan.toAdd.map((candidate) => candidate.uri),
        config.orderedAdds,
      )
    }
  }

  let reordered = false
  if (config.reorder && plan.tracked.length > 0) {
    if (order !== undefined) {
      // Project the writes on a dry run; on a real run they have already landed,
      // but re-reading the list would cost another page of calls for no gain.
      const effective = projectOrder(order, plan)
      const reorder = planReorder({ tracked: plan.tracked, currentOrder: effective })
      if (reorder.addUris.length > 0) {
        reordered = true
        console.log(`\nRe-ordering ${reorder.addUris.length} script-added episodes.`)
        if (!config.dryRun) {
          await libraryWrite(client, 'DELETE', reorder.removeUris)
          await libraryWrite(client, 'PUT', reorder.addUris, config.orderedAdds)
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
      everAdded: mergeEverAdded(
        state.everAdded,
        plan.tracked.map((candidate) => candidate.uri),
      ),
    })
  }

  console.log(
    `\nadded ${plan.toAdd.length}, removed ${plan.toRemove.length}, ` +
      `reordered ${reordered ? 'yes' : 'no'}, tracked ${plan.tracked.length}, ` +
      `shows ${showCount}, ` +
      `manual ${plan.manual.length}, api calls ${client.callCount()}` +
      (config.dryRun ? ' (dry run)' : ''),
  )
}

main().catch((error: unknown) => {
  if (error instanceof TokenExpiredError) {
    console.error(`\n${error.message}`)
    process.exit(2)
  }
  if (error instanceof ApiError && error.status === 429 && error.retryAfter !== undefined) {
    // A Retry-After measured in hours is the Development Mode quota, not the
    // rolling rate limit. Nothing to do but wait for the window to roll over —
    // re-running before then only fails again.
    const resetsAt = new Date(Date.now() + error.retryAfter * 1000)
    console.error(
      `\nSpotify quota exhausted.\n\n${error.message}\n\n` +
        `The window rolls over at about ${resetsAt.toISOString()} ` +
        `(${Math.round(error.retryAfter / 360) / 10} hours from now).\n` +
        'Development Mode quota is counted per developer account, per day. Running\n' +
        'again before then will just fail. If this keeps happening, lengthen the cron\n' +
        'in .github/workflows/sync.yml — that is the only lever that reduces daily use.\n',
    )
    process.exit(3)
  }
  console.error(error)
  process.exit(1)
})
