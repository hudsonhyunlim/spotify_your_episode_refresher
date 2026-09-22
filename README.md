# spotify_your_episode_refresher

Keeps Spotify **Your Episodes** stocked with the newest unplayed episodes from every podcast
you follow, refreshed hourly.

The Apple Watch app and most car head units have no "latest episodes" view, but both show
Your Episodes, and playback position syncs through your account. So this turns Your Episodes
into a synthetic "newest unplayed" queue you can reach from anywhere, phone-free.

Each run:

1. reads every show you follow,
2. looks at the most recent episodes of each,
3. optionally discards anything you've finished (`SKIP_PLAYED`),
4. keeps the newest `MAX_EPISODES`, taking at most `MAX_PER_SHOW` from any one show,
5. adds what's missing, removes what it previously added once it falls out of that set,
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

This is the **only** part that has to happen on your own machine. Everything else — the hourly
sync, manual runs, changing settings — runs on GitHub. OAuth needs a browser already signed in
to your Spotify account so *you* can click Agree, which no CI runner can do.

Two ways to do it. Both produce the same token. Pick [**2b**](#2b-windows--no-tools-installed)
if you don't have Node and git and don't want to install them.

Scopes requested, and why:

| Scope | Needed for |
|---|---|
| `user-library-read` | reading followed shows and what's already saved |
| `user-library-modify` | adding and removing episodes |
| `user-read-playback-position` | `resume_point`, i.e. knowing what you've played |

#### 2a. With Node and git

```sh
git clone <this repo> && cd spotify_your_episode_refresher
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth
```

Your browser opens, you approve the three scopes, and the script prints your refresh token
along with the exact `gh secret set` commands to run.

#### 2b. Windows — no tools installed

Browser plus built-in PowerShell. Nothing to install.

The trick: **the `127.0.0.1:8888` listener isn't actually required.** Spotify redirects your
*browser* there with the authorization code in the query string. With nothing listening the
browser shows an error page — but the code is still in the address bar, which is all you need.
The redirect URI must still be registered in the dashboard, because Spotify validates it on
both requests below.

**Authorize.** Paste into your address bar, replacing `YOUR_CLIENT_ID`:

```
https://accounts.spotify.com/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A8888%2Fcallback&scope=user-library-read%20user-library-modify%20user-read-playback-position
```

Click **Agree**. The browser then fails to load `127.0.0.1:8888` — *"This site can't be
reached" is the expected outcome.* Look at the address bar:

```
http://127.0.0.1:8888/callback?code=AQDx7...very-long-string...
```

Copy everything after `code=`. It is single-use and short-lived, so do the next step promptly;
if it expires, just reload the authorize URL for a fresh one.

**Exchange it.** Open PowerShell (Start → type `powershell` → Enter) and paste:

```powershell
$clientId     = 'YOUR_CLIENT_ID'
$clientSecret = 'YOUR_CLIENT_SECRET'
$code         = 'THE_CODE_FROM_THE_ADDRESS_BAR'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$basic = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("$($clientId):$($clientSecret)"))

$resp = Invoke-RestMethod -Method Post -Uri 'https://accounts.spotify.com/api/token' `
  -Headers @{ Authorization = "Basic $basic" } `
  -Body @{
      grant_type   = 'authorization_code'
      code         = $code
      redirect_uri = 'http://127.0.0.1:8888/callback'
  }

$resp.refresh_token
```

It prints your refresh token. The `SecurityProtocol` line matters — Windows PowerShell 5.1 can
still default to TLS 1.0, which Spotify rejects.

| Error | Fix |
|---|---|
| `invalid_grant` | The code expired or was already used. Reload the authorize URL for a new one. |
| `invalid_client` | Client ID or secret wrong, or has a stray space or quote. |
| `Invalid redirect URI` | The dashboard URI doesn't match `http://127.0.0.1:8888/callback` exactly. |
| `Could not create SSL/TLS secure channel` | You skipped the `SecurityProtocol` line. |

To see a full error body, wrap the call in `try { … } catch { $_.ErrorDetails.Message }`.

### 3. Set the repository secrets

In the browser: repo → **Settings** → **Secrets and variables** → **Actions** → **New
repository secret**, three times — `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`,
`SPOTIFY_REFRESH_TOKEN`.

Or with the `gh` CLI:

```sh
gh secret set SPOTIFY_CLIENT_ID
gh secret set SPOTIFY_CLIENT_SECRET
gh secret set SPOTIFY_REFRESH_TOKEN
```

Prefer the interactive prompt over `--body '...'`, which puts the secret into your shell
history. Secrets are repository-wide, not per-branch.

### 4. Check the plan before anything is written

On GitHub: **Actions** → **Sync Your Episodes** → **Run workflow**, and tick the box labelled
*"Plan only, change nothing"* (that is the `dry_run` input — GitHub shows an input's
description as its label). Expand the **Sync** step to read the planned selection.

Locally, if you have Node:

```sh
DRY_RUN=1 npm start
```

Either way it prints the episodes it would maintain, plus every planned add and remove, and
changes nothing — not your library, not `state.json`. Worth reading once against what you'd
pick by hand.

Note the **Run workflow** button only appears once the workflow file is on the default branch;
`schedule` likewise only fires from the default branch.

## Configuration

All optional, set as environment variables (or `env:` entries in `.github/workflows/sync.yml`):

| Variable | Default | Meaning |
|---|---|---|
| `MAX_EPISODES` | `20` | How many episodes to keep in Your Episodes |
| `MAX_PER_SHOW` | `0` | At most this many from any one show; `0` disables the cap |
| `SKIP_PLAYED` | `1` | `0` keeps finished episodes, ageing them out by release date |
| `PLAYED_THRESHOLD_PERCENT` | `0` | Count an episode this far through as finished; `0` uses `fully_played` alone |
| `EPISODES_PER_SHOW` | `5` | How far back to look in each followed show (API maximum 50) |
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

## Show diversity

A list ranked purely by release date is dominated by whoever publishes most often. With ~76
followed shows, the first run filled 20 slots from only 16 shows, four of them daily news
podcasts taking two slots each — and 60 followed shows never appeared at all.

`MAX_PER_SHOW` caps each show's share, trading a little recency for breadth. The workflow uses
`MAX_EPISODES=50` with `MAX_PER_SHOW=2`, so the list holds at least 25 distinct shows and in
practice more, since most shows contribute only one episode.

| `MAX_PER_SHOW` | Minimum distinct shows in 50 slots | Character |
|---|---|---|
| `1` | 50 | Maximum breadth; a daily show's older episode never appears |
| `2` (current) | 25 | Breadth, with room for a second episode from busy shows |
| `3` | 17 | Leans toward daily publishers |
| `0` | no floor | Pure recency; ~16 of 76 shows in practice |

## What counts as finished

By default (`SKIP_PLAYED=1`) finished episodes are dropped from the selection, so playing one
causes the next run to remove it and backfill with the next newest.

"Finished" means Spotify's own `resume_point.fully_played` flag. **Partially played episodes
are kept** — an episode you are 20% or 90% through stays in the list, which is usually what you
want: you have not finished it.

That flag is binary, though, and Spotify does not necessarily set it for an episode you are 99%
through. `PLAYED_THRESHOLD_PERCENT` adds a proportional check on top: at `95`, anything past
95% of its duration is treated as finished, while 90% still stays. Set it to `0` to rely on the
flag alone. Episodes whose duration Spotify does not report fall back to the flag rather than
being wrongly dropped.

`SKIP_PLAYED=0` turns the whole filter off — the list becomes simply the newest N regardless of
what you have listened to, and finished episodes stay until they age out by release date. That
also skips the `resume_point` verification below entirely, since played state can no longer
change the outcome.

## Played-state accuracy

`GET /shows/{id}/episodes` is known to return stale `resume_point` values, while
`GET /episodes/{id}` is accurate. So the script re-checks played state individually for the
shortlisted episodes and everything it currently tracks — roughly 20–40 extra calls per run.
`VERIFY_RESUME_POINTS=0` skips this, at the cost of played episodes occasionally lingering for
a run or two. It is also skipped automatically when `SKIP_PLAYED=0`, since played state cannot
change the outcome in that mode.

## Refresh token expiry

**Refresh tokens expire six months after the original authorization**, and refreshing an access
token does not extend that. When it lapses, the workflow fails with a clear `invalid_grant`
message and exit code 2, and GitHub emails you about the failed run.

To recover, repeat [step 2](#2-get-a-refresh-token) and update the `SPOTIFY_REFRESH_TOKEN`
secret. Nothing else changes — the Spotify app, the client ID and the secret all stay as they
are.

If you have Node:

```sh
SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth
gh secret set SPOTIFY_REFRESH_TOKEN
```

If you don't, use [2b](#2b-windows--no-tools-installed) — browser and PowerShell, no installs.

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
