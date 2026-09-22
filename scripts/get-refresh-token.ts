/**
 * One-off interactive helper: runs the authorization code flow against a loopback
 * listener and prints the refresh token.
 *
 * This has to run on a machine with a browser signed in to the target Spotify
 * account — it cannot run on CI, and the resulting token is the only credential the
 * workflow needs beyond the client ID and secret.
 *
 *   SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth
 */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { URL } from 'node:url'

// Spotify stopped accepting `localhost`; the loopback IP literal is required, and
// this must match the redirect URI registered in the dashboard exactly.
const REDIRECT_URI = 'http://127.0.0.1:8888/callback'
const PORT = 8888
const SCOPES = 'user-library-read user-library-modify user-read-playback-position'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    console.error(`Missing ${name}. Run:\n`)
    console.error('  SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... npm run auth\n')
    process.exit(1)
  }
  return value
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    spawn(command, [url], { detached: true, stdio: 'ignore', shell: process.platform === 'win32' })
      .unref()
  } catch {
    // Headless or locked-down machine — the URL is printed below either way.
  }
}

const clientId = requireEnv('SPOTIFY_CLIENT_ID')
const clientSecret = requireEnv('SPOTIFY_CLIENT_SECRET')
const state = randomBytes(16).toString('hex')

async function exchange(code: string): Promise<void> {
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64')
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  })

  const payload = (await response.json()) as Record<string, unknown>
  if (!response.ok || typeof payload.refresh_token !== 'string') {
    console.error(`\nToken exchange failed (${response.status}):`, payload)
    process.exit(1)
  }

  console.log(`\n${'='.repeat(72)}`)
  console.log('Refresh token:\n')
  console.log(`  ${payload.refresh_token}\n`)
  console.log('Set all three secrets on the repository:\n')
  console.log(`  gh secret set SPOTIFY_CLIENT_ID     --body '${clientId}'`)
  console.log("  gh secret set SPOTIFY_CLIENT_SECRET --body '<your client secret>'")
  console.log(`  gh secret set SPOTIFY_REFRESH_TOKEN --body '${payload.refresh_token}'`)
  console.log('\nThis token expires roughly six months from now. When the workflow starts')
  console.log('failing with invalid_grant, re-run this script and update the secret.')
  console.log('='.repeat(72))
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', REDIRECT_URI)
  if (url.pathname !== '/callback') {
    res.writeHead(404).end('Not found')
    return
  }

  const error = url.searchParams.get('error')
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')

  if (error !== null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end(`Authorization failed: ${error}`)
    console.error(`\nAuthorization denied: ${error}`)
    server.close(() => process.exit(1))
    return
  }
  if (returnedState !== state) {
    // The state parameter is the only thing tying this callback to the request
    // this process actually made.
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('State mismatch')
    console.error('\nState mismatch — ignoring this callback.')
    server.close(() => process.exit(1))
    return
  }
  if (code === null) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('No code')
    return
  }

  res
    .writeHead(200, { 'Content-Type': 'text/html' })
    .end('<h1>Done</h1><p>Refresh token printed in your terminal. You can close this tab.</p>')

  exchange(code)
    .then(() => server.close(() => process.exit(0)))
    .catch((err: unknown) => {
      console.error(err)
      server.close(() => process.exit(1))
    })
})

server.listen(PORT, '127.0.0.1', () => {
  const authorizeUrl = new URL('https://accounts.spotify.com/authorize')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authorizeUrl.searchParams.set('scope', SCOPES)
  authorizeUrl.searchParams.set('state', state)

  console.log('Opening your browser to authorize. If nothing happens, visit:\n')
  console.log(`  ${authorizeUrl.toString()}\n`)
  openBrowser(authorizeUrl.toString())
})

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Free it and try again.`)
    process.exit(1)
  }
  throw error
})
