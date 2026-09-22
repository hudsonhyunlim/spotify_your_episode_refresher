/**
 * Every decision this project makes lives here, as pure functions over plain data.
 * Nothing in this file performs I/O, which is what makes `test/select.test.ts`
 * able to cover the behaviour that actually matters without touching the network.
 */
import type { Candidate, StateEntry, SyncState } from './types.ts'

/** Spotify accepts at most 40 URIs per `/me/library` call. */
export const URIS_PER_REQUEST = 40

export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1')
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * `release_date` is only as precise as `release_date_precision` claims: a
 * year-precision episode arrives as "2026", a month-precision one as "2026-09".
 * Pad both out so plain string comparison sorts them correctly against full dates.
 */
export function normalizeReleaseDate(
  releaseDate: string,
  precision: 'year' | 'month' | 'day',
): string {
  if (precision === 'year') return `${releaseDate}-01-01`
  if (precision === 'month') return `${releaseDate}-01`
  return releaseDate
}

/**
 * Newest release first. Ties break on URI so a run is deterministic — without
 * this, two episodes sharing a release date could swap places between runs and
 * trigger pointless re-ordering churn.
 */
function byNewestRelease(a: Candidate, b: Candidate): number {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? 1 : -1
  return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0
}

/** Drop finished episodes, then keep the newest `maxEpisodes`. */
export function selectEpisodes({
  candidates,
  maxEpisodes,
}: {
  candidates: readonly Candidate[]
  maxEpisodes: number
}): Candidate[] {
  return candidates
    .filter((candidate) => !candidate.fullyPlayed)
    .slice()
    .sort(byNewestRelease)
    .slice(0, Math.max(0, maxEpisodes))
}

export interface ChangePlan {
  /** Selected episodes not currently in the library. Oldest release first, so the newest lands on top. */
  toAdd: Candidate[]
  /** Script-added URIs that are played, or have fallen out of the top N. */
  toRemove: string[]
  /** Selected episodes already saved by hand. Never tracked, therefore never removed. */
  manual: string[]
  /** The script-added set as it will stand after this run, newest release first. */
  tracked: Candidate[]
}

/**
 * The manual-save guarantee lives in this function. An episode the script did not
 * add is never recorded in state, and only recorded URIs are ever removed — so a
 * hand-saved episode cannot be pruned, even when it also happens to be in the top N.
 */
export function planChanges({
  selected,
  state,
  saved,
}: {
  selected: readonly Candidate[]
  state: SyncState
  /** URIs currently present in Your Episodes, per `GET /me/library/contains`. */
  saved: ReadonlySet<string>
}): ChangePlan {
  const scriptUris = new Set(state.added.map((entry) => entry.uri))
  const selectedUris = new Set(selected.map((candidate) => candidate.uri))

  const manual: string[] = []
  const tracked: Candidate[] = []
  const toAdd: Candidate[] = []

  for (const candidate of selected) {
    const isSaved = saved.has(candidate.uri)
    const isScript = scriptUris.has(candidate.uri)

    if (isSaved && !isScript) {
      // Already in Your Episodes but absent from state: the user saved this by hand.
      manual.push(candidate.uri)
      continue
    }
    if (!isSaved) toAdd.push(candidate)
    tracked.push(candidate)
  }

  const toRemove = state.added
    .filter((entry) => saved.has(entry.uri) && !selectedUris.has(entry.uri))
    .map((entry) => entry.uri)

  return {
    // Adds go oldest-first because Your Episodes orders most-recently-added first.
    toAdd: toAdd.slice().reverse(),
    toRemove,
    manual,
    tracked,
  }
}

/**
 * Carries the original `addedAt` forward for episodes already tracked, so the
 * timestamp records when the script first added an episode rather than when it
 * last confirmed it.
 */
export function toStateEntries(
  tracked: readonly Candidate[],
  previous: SyncState,
  now: string,
): StateEntry[] {
  const seenAt = new Map(previous.added.map((entry) => [entry.uri, entry.addedAt]))
  return tracked.map((candidate) => ({
    uri: candidate.uri,
    showId: candidate.showId,
    releaseDate: candidate.releaseDate,
    addedAt: seenAt.get(candidate.uri) ?? now,
  }))
}

export interface ReorderPlan {
  removeUris: string[]
  addUris: string[]
}

/**
 * Your Episodes is ordered most-recently-added first, so appending newer episodes
 * over time leaves the list out of release order. Removing the script-added set and
 * re-adding it oldest-first restores it. Playback position is stored on the account
 * rather than on library membership, so the round trip does not lose progress.
 */
export function planReorder({
  tracked,
  currentOrder,
}: {
  /** The script-added set, newest release first. */
  tracked: readonly Candidate[]
  /** Library URIs in display order (most recently added first). */
  currentOrder: readonly string[]
}): ReorderPlan {
  const desired = tracked.map((candidate) => candidate.uri)
  const desiredSet = new Set(desired)
  const observed = currentOrder.filter((uri) => desiredSet.has(uri))

  const alreadyCorrect =
    observed.length === desired.length && observed.every((uri, i) => uri === desired[i])
  if (alreadyCorrect) return { removeUris: [], addUris: [] }

  return {
    removeUris: desired,
    // Oldest first, so the newest release ends up at the top of the list.
    addUris: desired.slice().reverse(),
  }
}
