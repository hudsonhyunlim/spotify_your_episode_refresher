import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  URIS_PER_REQUEST,
  chunk,
  isFinished,
  normalizeReleaseDate,
  planChanges,
  planReorder,
  selectEpisodes,
  toStateEntries,
} from '../src/select.ts'
import type { Candidate, SyncState } from '../src/types.ts'

function episode(overrides: Partial<Candidate> & { uri: string }): Candidate {
  return {
    id: overrides.uri.split(':').pop() ?? 'id',
    name: 'Episode',
    showId: 'show1',
    showName: 'A Show',
    releaseDate: '2026-09-01',
    fullyPlayed: false,
    durationMs: 60 * 60 * 1000,
    resumePositionMs: 0,
    ...overrides,
  }
}

function state(uris: string[]): SyncState {
  return {
    version: 1,
    added: uris.map((uri) => ({
      uri,
      showId: 'show1',
      releaseDate: '2026-09-01',
      addedAt: '2026-09-01T00:00:00.000Z',
    })),
  }
}

test('normalizeReleaseDate pads coarse precisions so dates sort correctly', () => {
  assert.equal(normalizeReleaseDate('2026', 'year'), '2026-01-01')
  assert.equal(normalizeReleaseDate('2026-09', 'month'), '2026-09-01')
  assert.equal(normalizeReleaseDate('2026-09-21', 'day'), '2026-09-21')

  // The point of padding: a day-precision date must still outrank a coarse one.
  const selected = selectEpisodes({
    candidates: [
      episode({ uri: 'spotify:episode:coarse', releaseDate: normalizeReleaseDate('2026', 'year') }),
      episode({ uri: 'spotify:episode:exact', releaseDate: '2026-09-21' }),
    ],
    maxEpisodes: 2,
  })
  assert.deepEqual(
    selected.map((c) => c.uri),
    ['spotify:episode:exact', 'spotify:episode:coarse'],
  )
})

test('selectEpisodes returns the newest unplayed episodes, newest first', () => {
  const selected = selectEpisodes({
    candidates: [
      episode({ uri: 'spotify:episode:old', releaseDate: '2026-01-01' }),
      episode({ uri: 'spotify:episode:new', releaseDate: '2026-09-20' }),
      episode({ uri: 'spotify:episode:mid', releaseDate: '2026-05-05' }),
    ],
    maxEpisodes: 2,
  })
  assert.deepEqual(
    selected.map((c) => c.uri),
    ['spotify:episode:new', 'spotify:episode:mid'],
  )
})

test('selectEpisodes drops fully played episodes', () => {
  const selected = selectEpisodes({
    candidates: [
      episode({ uri: 'spotify:episode:played', releaseDate: '2026-09-20', fullyPlayed: true }),
      episode({ uri: 'spotify:episode:fresh', releaseDate: '2026-09-19' }),
    ],
    maxEpisodes: 10,
  })
  assert.deepEqual(
    selected.map((c) => c.uri),
    ['spotify:episode:fresh'],
  )
})

test('selectEpisodes handles an empty library and an all-played show', () => {
  assert.deepEqual(selectEpisodes({ candidates: [], maxEpisodes: 20 }), [])
  assert.deepEqual(
    selectEpisodes({
      candidates: [
        episode({ uri: 'spotify:episode:a', fullyPlayed: true }),
        episode({ uri: 'spotify:episode:b', fullyPlayed: true }),
      ],
      maxEpisodes: 20,
    }),
    [],
  )
})

test('selectEpisodes breaks release-date ties deterministically', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:b', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:a', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:c', releaseDate: '2026-09-20' }),
  ]
  const first = selectEpisodes({ candidates, maxEpisodes: 3 }).map((c) => c.uri)
  const again = selectEpisodes({ candidates: [...candidates].reverse(), maxEpisodes: 3 }).map(
    (c) => c.uri,
  )
  assert.deepEqual(first, ['spotify:episode:a', 'spotify:episode:b', 'spotify:episode:c'])
  assert.deepEqual(first, again, 'input order must not affect the result')
})

test('selectEpisodes does not mutate its input', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:a', releaseDate: '2026-01-01' }),
    episode({ uri: 'spotify:episode:b', releaseDate: '2026-09-01' }),
  ]
  const before = candidates.map((c) => c.uri)
  selectEpisodes({ candidates, maxEpisodes: 2 })
  assert.deepEqual(
    candidates.map((c) => c.uri),
    before,
  )
})

test('maxPerShow caps how many slots one show can take', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:d1', showId: 'daily', releaseDate: '2026-09-22' }),
    episode({ uri: 'spotify:episode:d2', showId: 'daily', releaseDate: '2026-09-21' }),
    episode({ uri: 'spotify:episode:d3', showId: 'daily', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:d4', showId: 'daily', releaseDate: '2026-09-19' }),
    episode({ uri: 'spotify:episode:w1', showId: 'weekly', releaseDate: '2026-09-15' }),
  ]

  // Without a cap the daily show crowds the weekly one out entirely.
  assert.deepEqual(
    selectEpisodes({ candidates, maxEpisodes: 4 }).map((c) => c.showId),
    ['daily', 'daily', 'daily', 'daily'],
  )

  const capped = selectEpisodes({ candidates, maxEpisodes: 4, maxPerShow: 3 })
  assert.deepEqual(capped.map((c) => c.uri), [
    'spotify:episode:d1',
    'spotify:episode:d2',
    'spotify:episode:d3',
    'spotify:episode:w1',
  ])
})

test('maxPerShow keeps the newest episodes of each show, and overall order', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:a-old', showId: 'a', releaseDate: '2026-09-01' }),
    episode({ uri: 'spotify:episode:a-new', showId: 'a', releaseDate: '2026-09-22' }),
    episode({ uri: 'spotify:episode:b-mid', showId: 'b', releaseDate: '2026-09-10' }),
  ]
  const selected = selectEpisodes({ candidates, maxEpisodes: 10, maxPerShow: 1 })
  assert.deepEqual(selected.map((c) => c.uri), [
    'spotify:episode:a-new',
    'spotify:episode:b-mid',
  ])
})

test('maxPerShow of 0 or less means no cap', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:x1', showId: 's', releaseDate: '2026-09-02' }),
    episode({ uri: 'spotify:episode:x2', showId: 's', releaseDate: '2026-09-01' }),
  ]
  assert.equal(selectEpisodes({ candidates, maxEpisodes: 10, maxPerShow: 0 }).length, 2)
  assert.equal(selectEpisodes({ candidates, maxEpisodes: 10 }).length, 2)
})

test('skipPlayed false keeps finished episodes in the selection', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:played', releaseDate: '2026-09-22', fullyPlayed: true }),
    episode({ uri: 'spotify:episode:fresh', releaseDate: '2026-09-21' }),
  ]

  assert.deepEqual(
    selectEpisodes({ candidates, maxEpisodes: 10, skipPlayed: true }).map((c) => c.uri),
    ['spotify:episode:fresh'],
  )
  // Played episodes now age out by release date rather than by being listened to.
  assert.deepEqual(
    selectEpisodes({ candidates, maxEpisodes: 10, skipPlayed: false }).map((c) => c.uri),
    ['spotify:episode:played', 'spotify:episode:fresh'],
  )
})

test('maxPerShow and skipPlayed compose', () => {
  const candidates = [
    episode({ uri: 'spotify:episode:p1', showId: 'a', releaseDate: '2026-09-22', fullyPlayed: true }),
    episode({ uri: 'spotify:episode:p2', showId: 'a', releaseDate: '2026-09-21' }),
    episode({ uri: 'spotify:episode:p3', showId: 'a', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:b1', showId: 'b', releaseDate: '2026-09-19' }),
  ]
  // A played episode still consumes one of the show's slots when it is not filtered.
  assert.deepEqual(
    selectEpisodes({ candidates, maxEpisodes: 10, maxPerShow: 2, skipPlayed: false }).map(
      (c) => c.uri,
    ),
    ['spotify:episode:p1', 'spotify:episode:p2', 'spotify:episode:b1'],
  )
  assert.deepEqual(
    selectEpisodes({ candidates, maxEpisodes: 10, maxPerShow: 2, skipPlayed: true }).map(
      (c) => c.uri,
    ),
    ['spotify:episode:p2', 'spotify:episode:p3', 'spotify:episode:b1'],
  )
})

test('playedThreshold treats a nearly-finished episode as finished', () => {
  const hour = 60 * 60 * 1000
  const candidates = [
    // 99% through: not flagged by Spotify, but effectively done with.
    episode({ uri: 'spotify:episode:almost', durationMs: hour, resumePositionMs: hour * 0.99 }),
    // 90% through: still worth keeping.
    episode({ uri: 'spotify:episode:mostly', durationMs: hour, resumePositionMs: hour * 0.9 }),
  ]

  // Without a threshold, Spotify's flag is the only signal and both survive.
  assert.equal(selectEpisodes({ candidates, maxEpisodes: 10 }).length, 2)

  assert.deepEqual(
    selectEpisodes({ candidates, maxEpisodes: 10, playedThreshold: 0.95 }).map((c) => c.uri),
    ['spotify:episode:mostly'],
  )
})

test('playedThreshold is exclusive of episodes exactly at the boundary', () => {
  const hour = 60 * 60 * 1000
  const atBoundary = episode({
    uri: 'spotify:episode:edge',
    durationMs: hour,
    resumePositionMs: hour * 0.95,
  })
  assert.equal(isFinished(atBoundary, 0.95), true, 'at the threshold counts as finished')
  assert.equal(isFinished(atBoundary, 0.96), false)
})

test('an unknown duration falls back to the fully_played flag', () => {
  // Never drop an episode just because Spotify omitted its duration.
  const unknown = episode({ uri: 'spotify:episode:nodur', durationMs: 0, resumePositionMs: 999 })
  assert.equal(isFinished(unknown, 0.95), false)
  assert.equal(isFinished({ ...unknown, fullyPlayed: true }, 0.95), true)
})

test('fully_played still wins regardless of threshold', () => {
  const played = episode({ uri: 'spotify:episode:done', fullyPlayed: true, resumePositionMs: 0 })
  assert.equal(isFinished(played, 0), true)
  assert.equal(isFinished(played, 0.95), true)
})

test('planChanges adds unsaved selections oldest first', () => {
  const selected = [
    episode({ uri: 'spotify:episode:new', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:old', releaseDate: '2026-09-01' }),
  ]
  const plan = planChanges({ selected, state: state([]), saved: new Set() })

  // Your Episodes shows most-recently-added first, so the newest release is added last.
  assert.deepEqual(plan.toAdd.map((c) => c.uri), [
    'spotify:episode:old',
    'spotify:episode:new',
  ])
  assert.deepEqual(plan.toRemove, [])
  assert.deepEqual(plan.tracked.map((c) => c.uri), [
    'spotify:episode:new',
    'spotify:episode:old',
  ])
})

test('an already-saved episode absent from state is treated as a manual save', () => {
  const selected = [episode({ uri: 'spotify:episode:manual' })]
  const plan = planChanges({
    selected,
    state: state([]),
    saved: new Set(['spotify:episode:manual']),
  })

  assert.deepEqual(plan.manual, ['spotify:episode:manual'])
  assert.deepEqual(plan.toAdd, [], 'already saved, nothing to add')
  assert.deepEqual(plan.tracked, [], 'never tracked, so it can never be pruned')
})

test('a manual save is never removed, even after it leaves the top N', () => {
  // It was adopted as manual on an earlier run, so it is not in state, so the
  // pruning pass has nothing to act on.
  const plan = planChanges({
    selected: [episode({ uri: 'spotify:episode:other' })],
    state: state([]),
    saved: new Set(['spotify:episode:manual', 'spotify:episode:other']),
  })
  assert.deepEqual(plan.toRemove, [])
})

test('planChanges removes a script-added episode once it has been played', () => {
  // A played episode never reaches `selected`, which is what marks it for removal.
  const plan = planChanges({
    selected: [],
    state: state(['spotify:episode:played']),
    saved: new Set(['spotify:episode:played']),
  })
  assert.deepEqual(plan.toRemove, ['spotify:episode:played'])
  assert.deepEqual(plan.tracked, [])
})

test('planChanges removes a script-added episode that falls out of the top N', () => {
  const plan = planChanges({
    selected: [episode({ uri: 'spotify:episode:keeper', releaseDate: '2026-09-20' })],
    state: state(['spotify:episode:keeper', 'spotify:episode:dropped']),
    saved: new Set(['spotify:episode:keeper', 'spotify:episode:dropped']),
  })
  assert.deepEqual(plan.toRemove, ['spotify:episode:dropped'])
  assert.deepEqual(plan.tracked.map((c) => c.uri), ['spotify:episode:keeper'])
})

test('planChanges skips removal for a tracked episode the user already deleted', () => {
  const plan = planChanges({
    selected: [],
    state: state(['spotify:episode:gone']),
    saved: new Set(),
  })
  assert.deepEqual(plan.toRemove, [], 'no point issuing a delete for something absent')
})

test('toStateEntries preserves the original addedAt for episodes already tracked', () => {
  const previous = state(['spotify:episode:known'])
  const entries = toStateEntries(
    [episode({ uri: 'spotify:episode:known' }), episode({ uri: 'spotify:episode:fresh' })],
    previous,
    '2026-09-22T12:00:00.000Z',
  )
  assert.equal(entries[0]?.addedAt, '2026-09-01T00:00:00.000Z')
  assert.equal(entries[1]?.addedAt, '2026-09-22T12:00:00.000Z')
})

test('planReorder is a no-op when the list is already newest first', () => {
  const tracked = [
    episode({ uri: 'spotify:episode:new', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:old', releaseDate: '2026-09-01' }),
  ]
  const plan = planReorder({
    tracked,
    currentOrder: ['spotify:episode:new', 'spotify:episode:old'],
  })
  assert.deepEqual(plan, { removeUris: [], addUris: [] })
})

test('planReorder re-adds oldest first so the newest release lands on top', () => {
  const tracked = [
    episode({ uri: 'spotify:episode:new', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:old', releaseDate: '2026-09-01' }),
  ]
  const plan = planReorder({
    tracked,
    currentOrder: ['spotify:episode:old', 'spotify:episode:new'],
  })
  assert.deepEqual(plan.removeUris, ['spotify:episode:new', 'spotify:episode:old'])
  assert.deepEqual(plan.addUris, ['spotify:episode:old', 'spotify:episode:new'])
})

test('planReorder ignores manual saves interleaved in the list', () => {
  const tracked = [
    episode({ uri: 'spotify:episode:new', releaseDate: '2026-09-20' }),
    episode({ uri: 'spotify:episode:old', releaseDate: '2026-09-01' }),
  ]
  const plan = planReorder({
    tracked,
    currentOrder: ['spotify:episode:manual', 'spotify:episode:new', 'spotify:episode:old'],
  })
  assert.deepEqual(plan, { removeUris: [], addUris: [] })
})

test('chunk splits at the 40-URI library limit', () => {
  const uris = Array.from({ length: 95 }, (_, i) => `spotify:episode:${i}`)
  const batches = chunk(uris, URIS_PER_REQUEST)

  assert.equal(URIS_PER_REQUEST, 40)
  assert.deepEqual(batches.map((b) => b.length), [40, 40, 15])
  assert.deepEqual(batches.flat(), uris)
  assert.deepEqual(chunk([], URIS_PER_REQUEST), [])
})
