/**
 * `state.json` is the record of which episodes this script put in Your Episodes.
 * It is the whole basis of the manual-save guarantee: anything absent from here is
 * treated as the user's own save and is never removed.
 */
import { readFile, writeFile } from 'node:fs/promises'
import type { SyncState } from './types.ts'

export const STATE_VERSION = 1

export function emptyState(): SyncState {
  return { version: STATE_VERSION, added: [] }
}

export async function readState(path: string): Promise<SyncState> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState()
    throw error
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `${path} is not valid JSON. Refusing to continue: a corrupt state file would ` +
        'make the script treat its own episodes as manual saves and orphan them. ' +
        `Reset it to {"version":${STATE_VERSION},"added":[]} if that is what you want.`,
    )
  }

  if (typeof parsed !== 'object' || parsed === null) return emptyState()
  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.added)) return emptyState()

  return {
    version: typeof record.version === 'number' ? record.version : STATE_VERSION,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : undefined,
    added: record.added.filter(
      (entry): entry is SyncState['added'][number] =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as Record<string, unknown>).uri === 'string',
    ),
  }
}

export async function writeState(path: string, state: SyncState): Promise<void> {
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
