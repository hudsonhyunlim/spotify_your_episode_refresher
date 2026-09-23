/**
 * Narrow shapes for the Spotify Web API responses this project actually touches,
 * plus the runtime guards used at the parse boundary. `fetch` hands back `unknown`,
 * so without these the `strict` setting would be decorative.
 */

/** Playback progress. Requires the `user-read-playback-position` scope. */
export interface ResumePoint {
  fully_played: boolean
  resume_position_ms: number
}

export interface SimplifiedEpisode {
  id: string
  uri: string
  name: string
  duration_ms: number
  release_date: string
  release_date_precision: 'year' | 'month' | 'day'
  resume_point?: ResumePoint
}

export interface Paging<T> {
  items: T[]
  next: string | null
}

export interface SavedShow {
  show: { id: string; name: string }
}

export interface SavedEpisode {
  added_at: string
  episode: { uri: string }
}

export interface UserProfile {
  id: string
  country?: string
}

/**
 * The flattened episode the selection logic works on. Deliberately decoupled from
 * the API shape so `src/select.ts` stays pure and trivially testable.
 */
export interface Candidate {
  uri: string
  id: string
  name: string
  showId: string
  showName: string
  /** Always a full `YYYY-MM-DD`, normalised from coarser precisions. */
  releaseDate: string
  /** Spotify's own "you finished this" flag. */
  fullyPlayed: boolean
  /** 0 when unknown, which disables the proportional played check for this episode. */
  durationMs: number
  resumePositionMs: number
}

/** One episode this script added to Your Episodes, and is therefore allowed to remove. */
export interface StateEntry {
  uri: string
  showId: string
  releaseDate: string
  addedAt: string
}

export interface SyncState {
  version: number
  updatedAt?: string
  /** Stored newest-release-first, matching the intended display order. */
  added: StateEntry[]
  /**
   * Every URI this script has ever added, newest first and capped.
   *
   * `added` only holds the current set, so an episode that drops out of it
   * becomes indistinguishable from one the user saved by hand — and therefore
   * un-removable. Anything that failed to delete then lingers in Your Episodes
   * forever. This is the longer memory that makes such strays identifiable.
   */
  everAdded?: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function asPaging<T>(value: unknown, what: string): Paging<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new Error(`Unexpected ${what} response: missing an "items" array`)
  }
  const next = value.next
  return {
    items: value.items as T[],
    next: typeof next === 'string' ? next : null,
  }
}

function asResumePoint(value: unknown): ResumePoint | undefined {
  if (!isRecord(value)) return undefined
  return {
    fully_played: value.fully_played === true,
    resume_position_ms:
      typeof value.resume_position_ms === 'number' ? value.resume_position_ms : 0,
  }
}

export function asEpisode(value: unknown, what: string): SimplifiedEpisode {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.uri !== 'string') {
    throw new Error(`Unexpected ${what} response: not an episode object`)
  }
  const precision = value.release_date_precision
  return {
    id: value.id,
    uri: value.uri,
    name: typeof value.name === 'string' ? value.name : '(untitled)',
    duration_ms: typeof value.duration_ms === 'number' ? value.duration_ms : 0,
    release_date: typeof value.release_date === 'string' ? value.release_date : '',
    release_date_precision:
      precision === 'year' || precision === 'month' ? precision : 'day',
    resume_point: asResumePoint(value.resume_point),
  }
}
