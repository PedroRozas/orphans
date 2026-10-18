import { expect, test } from 'claude-code/testing'

import {
  belongsToOtherSession,
  findForgotten,
  findLiveGroups,
  findOrphansBornBetween,
  findOwned,
  findStillAlive,
  findUnknown,
  isClaudeShell,
  parsePidTable,
  parseLsofOutput,
  parsePsOutput,
} from './processes'

const CLAUDE = 40936
const SESSION = '11fcefe1-3e56-4771-a782-b8d723a515c9'
const SHELL = `/bin/zsh -c source /Users/p/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run dev &'`

const ps = (lines: string[]): string => lines.join('\n')

const BEFORE = ps([
  '    1     0     1 Mon Oct  5 09:00:00 2026 /sbin/launchd',
  '40936  2490  2471 Tue Oct 13 19:00:00 2026 /path/claude --output-format stream-json',
  '  500     1   500 Mon Oct  5 09:01:00 2026 /usr/libexec/someDaemon',
  '  610     1   600 Mon Oct  5 09:02:00 2026 node /otro/proyecto/server.js',
])

const AFTER = ps([
  '    1     0     1 Mon Oct  5 09:00:00 2026 /sbin/launchd',
  '40936  2490  2471 Tue Oct 13 19:00:00 2026 /path/claude --output-format stream-json',
  '  500     1   500 Mon Oct  5 09:01:00 2026 /usr/libexec/someDaemon',
  '  610     1   600 Mon Oct  5 09:02:00 2026 node /otro/proyecto/server.js',
  '43746     1 43745 Tue Oct 13 19:46:07 2026 node next dev',
  '43750 43746 43745 Tue Oct 13 19:46:08 2026 node next-server',
  '43800     1 43800 Tue Oct 13 19:46:07 2026 /usr/libexec/newDaemon',
])

test('parsea ps con fechas de un dígito y comandos con espacios', () => {
  const rows = parsePsOutput(AFTER)
  expect(rows).toHaveLength(7)
  expect(rows[3]).toEqual({
    pid: 610,
    ppid: 1,
    pgid: 600,
    startedAt: 'Mon Oct  5 09:02:00 2026',
    command: 'node /otro/proyecto/server.js',
  })
})

test('atribuye solo los huérfanos nuevos cuyo líder de grupo murió durante la llamada', () => {
  const orphans = findOrphansBornBetween(parsePsOutput(BEFORE), parsePsOutput(AFTER))
  expect(orphans.map(row => row.pid)).toEqual([43746])
})

test('no toca procesos ajenos aunque sean huérfanos de grupos muertos previos', () => {
  const orphans = findOrphansBornBetween(parsePsOutput(BEFORE), parsePsOutput(AFTER))
  expect(orphans.some(row => row.pid === 610)).toBe(false)
  expect(orphans.some(row => row.pid === 43800)).toBe(false)
})

test('un grupo propio arrastra a los descendientes y deja fuera lo demás', () => {
  const rows = parsePsOutput(AFTER)
  const owned = findOwned(rows, new Set([43745]), CLAUDE)
  expect(owned.map(row => row.pid)).toEqual([43746, 43750])
  expect(findForgotten(rows, owned, CLAUDE).map(row => row.pid)).toEqual([43746, 43750])
})

test('lo que cuelga de una shell viva de Claude es propio pero no olvidado', () => {
  const rows = parsePsOutput(
    ps([
      `40936  2490  2471 Tue Oct 13 19:00:00 2026 /path/claude`,
      `45000 40936 45000 Tue Oct 13 19:50:00 2026 ${SHELL}`,
      '45001 45000 45000 Tue Oct 13 19:50:01 2026 node next dev',
      '45100 40936 45100 Tue Oct 13 19:50:00 2026 /bin/zsh -c otra cosa',
    ]),
  )
  const owned = findOwned(rows, new Set(), CLAUDE)
  expect(owned.map(row => row.pid)).toEqual([45000, 45001])
  expect(findForgotten(rows, owned, CLAUDE)).toEqual([])
})

test('un número de grupo reutilizado por un líder ajeno no lo vuelve propio', () => {
  const rows = parsePsOutput(ps(['43745     1 43745 Tue Oct 13 20:00:00 2026 /Applications/Otra.app']))
  expect(findOwned(rows, new Set([43745]), CLAUDE)).toEqual([])
})

test('descarta grupos sin procesos vivos', () => {
  expect(findLiveGroups(parsePsOutput(AFTER), new Set([43745, 99999]))).toEqual([43745])
})

test('reconoce la salida de tareas de otra sesión de Claude', () => {
  const lsof = ['p43746', 'f1', `n/private/tmp/claude-501/-proj/aaaaaaaa-3e56-4771-a782-b8d723a515c9/tasks/x1.output`, 'p43750', 'f1', 'n/dev/null'].join('\n')
  const paths = parseLsofOutput(lsof)
  expect(belongsToOtherSession(paths.get(43746) ?? [], SESSION)).toBe(true)
  expect(belongsToOtherSession(paths.get(43750) ?? [], SESSION)).toBe(false)
  expect(belongsToOtherSession([`/private/tmp/claude-501/-proj/${SESSION}/tasks/x2.output`], SESSION)).toBe(false)
})

test('un PID reutilizado con otra hora de inicio no cuenta como vivo', () => {
  const rows = parsePsOutput(AFTER)
  const alive = findStillAlive(rows, [
    { pid: 43746, startedAt: 'Tue Oct 13 19:46:07 2026', command: 'node next dev' },
    { pid: 43750, startedAt: 'Mon Oct 12 10:00:00 2026', command: 'node viejo' },
  ])
  expect(alive.map(identity => identity.pid)).toEqual([43746])
})

test('distingue procesos nuevos por PID y hora de inicio', () => {
  const known = [{ pid: 43746, startedAt: 'Tue Oct 13 19:46:07 2026', command: 'node next dev' }]
  const fresh = findUnknown(
    [
      { pid: 43746, startedAt: 'Tue Oct 13 19:46:07 2026', command: 'node next dev' },
      { pid: 43746, startedAt: 'Tue Oct 13 20:00:00 2026', command: 'node otro' },
      { pid: 43750, startedAt: 'Tue Oct 13 19:46:08 2026', command: 'node next-server' },
    ],
    known,
  )
  expect(fresh.map(identity => identity.pid)).toEqual([43746, 43750])
  expect(fresh[0]?.command).toBe('node otro')
})

test('parsea la tabla ligera de pid, ppid y pgid', () => {
  expect(parsePidTable('    1     0     1\n43746     1 43745\nbasura\n')).toEqual([
    { pid: 1, ppid: 0, pgid: 1 },
    { pid: 43746, ppid: 1, pgid: 43745 },
  ])
})

test('la atribución funciona con la tabla ligera como foto previa', () => {
  const before = parsePidTable(['    1     0     1', '40936  2490  2471', '  610     1   600'].join('\n'))
  const orphans = findOrphansBornBetween(before, parsePsOutput(AFTER))
  expect(orphans.map(row => row.pid)).toEqual([43746])
})

test('reconoce la shell de Claude por el snapshot que carga', () => {
  const [shell] = parsePsOutput(`45000 ${CLAUDE} 45000 Tue Oct 13 19:50:00 2026 ${SHELL}`)
  const [other] = parsePsOutput(`45001 ${CLAUDE} 45001 Tue Oct 13 19:50:00 2026 /bin/zsh -c ls`)
  expect(shell !== undefined && isClaudeShell(shell, CLAUDE)).toBe(true)
  expect(other !== undefined && isClaudeShell(other, CLAUDE)).toBe(false)
})
