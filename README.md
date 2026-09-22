# spotify_your_episode_refresher

Keeps Spotify **Your Episodes** stocked with the newest unplayed episodes from every podcast
you follow, refreshed hourly.

The Apple Watch app and most car head units have no "latest episodes" view, but both show
Your Episodes, and playback position syncs through your account. So this turns Your Episodes
into a synthetic "newest unplayed" queue you can reach from anywhere, phone-free.

Each run:

1. reads every show you follow,
2. looks at the most recent episodes of each,
3. discards anything you've finished,
4. keeps the newest `MAX_EPISODES` (default 20),
5. adds what's missing, removes what it previously added once it's played or has fallen out
   of the top N,
6. never touches an episode you saved yourself.

## Setup

### 1. Create the Spotify app

In the [Spotify developer dashboard](https://developer.spotify.com/dashboard), create an app and
add this **exact** redirect URI:

```
http://127.0.0.1:8888/callback
```

Spotify no longer accepts `localhost` — it has to be the loopback IP literal.

Note the **client ID** and **client secret**. The app stays in Development Mode, which means:

- the account that owns the app needs an active **Spotify Premium** subscription,
- at most **5 users** can be authorized,
- quota is counted per developer account.

### 2. Get a refresh token

Runs on your own machine — it needs a browser signed in to the Spotify account, and a listener
on your `127.0.0.1:8888`. It cannot run on CI.

```sh
git clone <this repo> && cd spotify_your_episode_refresher
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth
```

Your browser opens, you approve the three scopes, and the script prints your refresh token
along with the exact `gh secret set` commands to run.

Scopes requested, and why:

| Scope | Needed for |
|---|---|
| `user-library-read` | reading followed shows and what's already saved |
| `user-library-modify` | adding and removing episodes |
| `user-read-playback-position` | `resume_point`, i.e. knowing what you've played |

### 3. Set the repository secrets

```sh
gh secret set SPOTIFY_CLIENT_ID
gh secret set SPOTIFY_CLIENT_SECRET
gh secret set SPOTIFY_REFRESH_TOKEN
```

### 4. Check the plan before anything is written

```sh
DRY_RUN=1 npm start
```

This prints the top 20 it would maintain, plus every planned add and remove, and changes
nothing — not your library, not `state.json`. Worth eyeballing once against what you'd pick
by hand.

Then the same thing on Actions: run the **Sync Your Episodes** workflow manually with
`dry_run` checked. That proves the secrets and the runner work before anything touches your
library.

## Configuration

All optional, set as environment variables (or `env:` entries in `.github/workflows/sync.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `MAX_EPISODES` | `20` | How many episodes to keep in Your Episodes |
| `EPISODES_PER_SHOW` | `5` | How far back to look in each followed show |
| `DRY_RUN` | unset | `1` plans without changing anything |
| `REORDER` | `1` | `0` disables the re-ordering pass |
| `VERIFY_RESUME_POINTS` | `1` | `0` trusts the show listing's played state (see below) |
| `STATE_FILE` | `state.json` | Where the record of script-added episodes lives |
| `MAX_RETRIES` | `5` | Retries per request on 429 / 5xx |
| `MAX_RETRY_AFTER` | `600` | Give up rather than wait longer than this many seconds |

To change how many episodes are kept, edit `MAX_EPISODES` under the `Sync` step's `env:` in
`.github/workflows/sync.yml`, or set it locally:

```sh
MAX_EPISODES=40 npm start
```

## How it protects your own saves

`state.json` records exactly which episodes *this script* added. Pruning only ever considers
URIs listed there, so an episode you saved by hand cannot be removed.

If an episode is already in Your Episodes but absent from `state.json`, it's adopted as a
manual save: the script leaves it alone and never starts tracking it — even when that same
episode is also in the current top N.

One consequence worth knowing: if you manually *remove* an episode the script added while it's
still unplayed and still in the top N, the next run will add it back. Play it, or let it age
out of the top N.

## Ordering

Your Episodes is ordered most-recently-added first, so the script adds episodes oldest-release
first, putting the newest release on top. Because later runs append newer episodes underneath
older ones, each run also re-adds the script-added set in order when it has drifted. Playback
position lives on your account rather than on library membership, so this round trip doesn't
lose your place. Set `REORDER=0` to turn it off.

## Played-state accuracy

`GET /shows/{id}/episodes` is known to return stale `resume_point` values, while
`GET /episodes/{id}` is accurate. So the script re-checks played state individually for the
shortlisted episodes and everything it currently tracks — roughly 20–40 extra calls per run.
`VERIFY_RESUME_POINTS=0` skips this, at the cost of played episodes occasionally lingering for
a run or two.

## Refresh token expiry

**Refresh tokens expire six months after the original authorization**, and refreshing an access
token does not extend that. When it lapses, the workflow fails with a clear `invalid_grant`
message and exit code 2, and GitHub emails you about the failed run.

To recover, repeat step 2 and update the secret:

```sh
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth
gh secret set SPOTIFY_REFRESH_TOKEN
```

Separately, if Spotify ever rotates the token mid-life, the run logs a loud warning with the
new value — update the secret when you see it.

## Cost and scheduling

The hourly job runs on GitHub-hosted runners. Private repositories get 2,000 Actions
minutes/month on Free and 3,000 on Pro/Team, and **every job is rounded up to a whole minute**,
so ~730 runs/month is what matters, not the seconds.

That's why this project has **nothing in `dependencies`** and **no build step**: Node runs the
TypeScript directly via native type stripping, so the hourly job skips `npm ci` entirely and
finishes inside one billable minute (~730 min/month, about a third of the Free allowance).
Adding a single runtime dependency, or a `tsc` build, would roughly double that. Type checking
and linting happen in `ci.yml`, which only runs on pushes and pull requests.

Two things to know about `on: schedule`:

- It's **best effort**. Runs get delayed under load and are occasionally dropped. Harmless
  here — the next run reconciles from scratch.
- Scheduled workflows are **auto-disabled after 60 days with no repository activity**. The
  hourly `state.json` commit resets that clock whenever the list actually changes. If it ever
  does get disabled, re-enable it in the Actions tab and push any commit.

## Development

```sh
npm ci
npm test        # node --test, no framework
npm run typecheck
npm run lint
```

Requires Node 22.18+ (the version that runs TypeScript without a flag); CI and the workflows
use Node 26.

The selection, pruning and ordering rules live in `src/select.ts` as pure functions with no
I/O, which is what the test suite covers. `src/sync.ts` is the orchestration around them, and
`src/spotify.ts` is the API client.

`SPOTIFY_API_BASE` and `SPOTIFY_ACCOUNTS_URL` can be pointed at a local mock to exercise the
whole sync without touching the real API.

## Spotify API notes

This targets the endpoint set left after the **February 2026 Development Mode migration**:

- `PUT /me/library` and `DELETE /me/library` replace `PUT`/`DELETE /me/episodes`. `uris` is a
  **query parameter** — comma-separated, max 40, with an empty body, *not* a JSON payload.
- `GET /me/library/contains` replaces the per-type `contains` endpoints.
- Batch lookups (`GET /episodes`, `GET /shows`) were removed, so episodes are fetched one show
  at a time via `GET /shows/{id}/episodes`.
- `GET /me/shows` is the only way to enumerate followed shows; the script preflights it and
  fails with an explanation if it ever becomes unavailable.
- `GET /me/episodes` is used only to read the current list order, and the re-order pass is
  skipped gracefully if it isn't available.
