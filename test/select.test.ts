import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  URIS_PER_REQUEST,
  chunk,
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
