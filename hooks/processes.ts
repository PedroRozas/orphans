import type { ProcessIdentity } from '../types'

export type PidRow = {
  pid: number
  ppid: number
  pgid: number
}

export type ProcessRow = PidRow & {
  startedAt: string
  command: string
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/
const PID_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/
const TASK_OUTPUT = /\/([0-9a-f-]{36})\/tasks\/[^/]+\.output$/

export const parsePsOutput = (stdout: string): ProcessRow[] =>
  stdout.split('\n').flatMap(line => {
    const [, pid, ppid, pgid, startedAt, command] = PS_LINE.exec(line) ?? []
    if (startedAt === undefined || command === undefined) return []
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), startedAt, command }]
  })

export const parsePidTable = (stdout: string): PidRow[] =>
  stdout.split('\n').flatMap(line => {
    const [, pid, ppid, pgid] = PID_LINE.exec(line) ?? []
    if (pid === undefined || ppid === undefined || pgid === undefined) return []
    return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) }]
  })

export const parseLsofOutput = (stdout: string): Map<number, string[]> => {
  const pathsByPid = new Map<number, string[]>()
  let currentPid: number | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      currentPid = Number(line.slice(1))
      pathsByPid.set(currentPid, [])
    } else if (line.startsWith('n') && currentPid !== undefined) {
      pathsByPid.get(currentPid)?.push(line.slice(1))
    }
  }
  return pathsByPid
}

export const isClaudeShell = (row: ProcessRow, claudePid: number): boolean =>
  row.ppid === claudePid && row.command.includes('/shell-snapshots/')

export const toIdentity = ({ pid, startedAt, command }: ProcessRow): ProcessIdentity => ({
  pid,
  startedAt,
  command,
})

export const findOrphansBornBetween = (before: readonly PidRow[], after: readonly ProcessRow[]): ProcessRow[] => {
  const pidsBefore = new Set(before.map(row => row.pid))
  const pidsAfter = new Set(after.map(row => row.pid))
  return after.filter(
    row =>
      !pidsBefore.has(row.pid) &&
      row.ppid === 1 &&
      row.pgid !== row.pid &&
      !pidsAfter.has(row.pgid) &&
      !pidsBefore.has(row.pgid),
  )
}

export const belongsToOtherSession = (paths: readonly string[], sessionId: string): boolean =>
  paths.some(path => {
    const owner = TASK_OUTPUT.exec(path)?.[1]
    return owner !== undefined && owner !== sessionId
  })

const withDescendants = (rows: ProcessRow[], roots: ReadonlySet<number>): Set<number> => {
  const found = new Set(roots)
  let hasGrown = true
  while (hasGrown) {
    hasGrown = false
    for (const row of rows) {
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.add(row.pid)
        hasGrown = true
      }
    }
  }
  return found
}

export const findOwned = (
  rows: ProcessRow[],
  groups: ReadonlySet<number>,
  claudePid: number,
): ProcessRow[] => {
  const roots = rows
    .filter(row => isClaudeShell(row, claudePid) || (groups.has(row.pgid) && row.pid !== row.pgid))
    .map(row => row.pid)
  const owned = withDescendants(rows, new Set(roots))
  return rows.filter(row => owned.has(row.pid))
}

export const findForgotten = (rows: ProcessRow[], owned: ProcessRow[], claudePid: number): ProcessRow[] => {
  const liveShells = rows.filter(row => isClaudeShell(row, claudePid)).map(row => row.pid)
  const attached = withDescendants(rows, new Set(liveShells))
  return owned.filter(row => !attached.has(row.pid))
}

export const findLiveGroups = (rows: ProcessRow[], groups: ReadonlySet<number>): number[] => {
  const pgidsInUse = new Set(rows.map(row => row.pgid))
  return [...groups].filter(pgid => pgidsInUse.has(pgid))
}

export const findStillAlive = (rows: ProcessRow[], identities: readonly ProcessIdentity[]): ProcessIdentity[] => {
  const startedAtByPid = new Map(rows.map(row => [row.pid, row.startedAt]))
  return identities.filter(identity => startedAtByPid.get(identity.pid) === identity.startedAt)
}

const identityKey = ({ pid, startedAt }: ProcessIdentity): string => `${pid}@${startedAt}`

export const findUnknown = (
  identities: readonly ProcessIdentity[],
  known: readonly ProcessIdentity[],
): ProcessIdentity[] => {
  const knownKeys = new Set(known.map(identityKey))
  return identities.filter(identity => !knownKeys.has(identityKey(identity)))
}
