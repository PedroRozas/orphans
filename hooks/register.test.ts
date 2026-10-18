import type { ProcessRunResult } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type TestOn = Parameters<TestBody>[1]

const CLAUDE = 40936
const SESSION = '11fcefe1-3e56-4771-a782-b8d723a515c9'
const SHELL = `/bin/zsh -c source /Users/p/.claude/shell-snapshots/snapshot-zsh-1.sh && eval 'npm run dev'`

const BASE = [
  '    1     0     1 Mon Oct  5 09:00:00 2026 /sbin/launchd',
  `${CLAUDE}  2490  2471 Tue Oct 13 19:00:00 2026 /path/claude`,
]
const DETACHED_DEV = '43746     1 43745 Tue Oct 13 19:46:07 2026 node next dev'
const LIVE_SHELL = `45000 ${CLAUDE} 45000 Tue Oct 13 19:50:00 2026 ${SHELL}`
const SHELL_CHILD = '45001 45000 45000 Tue Oct 13 19:50:01 2026 node next dev'
const SHELL_CHILD_REPARENTED = '45001     1 45000 Tue Oct 13 19:50:01 2026 node next dev'

type World = {
  rows: string[]
  afterBash: string[]
  killed: number[]
  psRuns?: number
  isLightPsBroken?: boolean
}

const output = (stdout: string): ProcessRunResult => ({
  exitCode: 0,
  stdout,
  stderr: '',
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const pidTable = (rows: readonly string[]): string =>
  rows.map(row => row.trim().split(/\s+/).slice(0, 3).join(' ')).join('\n')

const installEngine = (on: TestOn, world: World, uname = 'Darwin') => {
  const statusLines: (string | undefined)[] = []
  const logs: string[] = []
  const registered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('session.id', () => ({ value: SESSION }))
  on('ui.status', ($, e) => {
    statusLines.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('fs.stat', ($, e) =>
    ['/bin/ps', '/bin/kill', '/usr/sbin/lsof'].includes(e.path)
      ? { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } }
      : { deny: 'ENOENT' },
  )
  on('process.run', ($, e) => {
    const [binary = ''] = e.argv
    if (binary === 'uname') return { value: output(`${uname}\n`) }
    if (binary === '/bin/ps') {
      world.psRuns = (world.psRuns ?? 0) + 1
      const isLight = e.argv.join(' ').endsWith('pid=,ppid=,pgid=')
      if (isLight && world.isLightPsBroken === true) return { deny: 'ps roto' }
      return { value: output(isLight ? pidTable(world.rows) : world.rows.join('\n')) }
    }
    if (binary === '/bin/sh') return { value: output(`${CLAUDE}\n`) }
    if (binary === '/usr/sbin/lsof') return { value: output('') }
    if (binary === '/bin/kill') {
      world.killed.push(...e.argv.slice(2).map(Number))
      return { value: output('') }
    }
    return { deny: `sin simulación para ${binary}` }
  })
  on('tool.call', { tool: 'Bash' }, () => {
    world.rows = [...world.rows, ...world.afterBash]
    world.afterBash = []
    return { result: { stdout: '', stderr: '' } }
  })
  mock.store(on)
  return { clock: mock.clock(on), session: mock.session(on), statusLines, logs, registered }
}

const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

test('pregunta a la sesión, pegado al resultado del Bash, por el proceso que dejó corriendo', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  installEngine(on, world)
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  expect(ran.deny).toBeUndefined()
  expect(ran.context).toHaveLength(1)
  const [question = ''] = ran.context ?? []
  expect(question).toContain('43746  node next dev')
  expect(question).toContain('kill 43746')
  expect(question).toContain('orphans:')
})

test('no vuelve a preguntar por un proceso ya preguntado', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  installEngine(on, world)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  const again = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(again.context).toBeUndefined()
})

test('lo que queda olvidado entre llamadas se pregunta con una fila en la conversación', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [LIVE_SHELL, SHELL_CHILD], killed: [] }
  const { clock, session } = installEngine(on, world)
  await start($)
  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev' })
  expect(ran.context).toBeUndefined()

  world.rows = [...BASE, SHELL_CHILD_REPARENTED]
  await clock.advance(30_000)

  const notes = session.appended().filter(row => row.door === 'note')
  expect(notes).toHaveLength(1)
  const [note] = notes
  expect(note?.message.type).toBe('user')
  expect(JSON.stringify(note?.message.content)).toContain('45001  node next dev')

  await clock.advance(30_000)
  expect(session.appended().filter(row => row.door === 'note')).toHaveLength(1)
})

test('un proceso que ya murió no se pregunta ni se mata', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  const { session } = installEngine(on, world)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  world.rows = [...BASE]
  const after = await $.tool.call({ tool: 'Bash', command: 'kill 43746' })

  expect(after.context).toBeUndefined()
  expect(session.appended().filter(row => row.door === 'note')).toHaveLength(0)
  expect(world.killed).toEqual([])
})

test('en español registra /huerfanos y pregunta en español', { options: { language: 'es' } }, async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  const { registered } = installEngine(on, world)
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  expect(registered).toEqual(['huerfanos'])
  expect(ran.context?.[0]).toContain('huerfanos: este comando dejó un proceso corriendo')
})

test('con askSession apagado no pregunta pero sigue contando en el status', { options: { askSession: false } }, async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  const { statusLines, session } = installEngine(on, world)
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  expect(ran.context).toBeUndefined()
  expect(session.appended().filter(row => row.door === 'note')).toHaveLength(0)
  expect(statusLines.at(-1)).toBe('1 background process · /orphans')
})

test('en un sistema no soportado avisa una vez y deja pasar cada Bash sin tocar ps', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  const { logs } = installEngine(on, world, 'MINGW64_NT-10.0')
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  expect(logs.some(line => line.includes('unsupported host'))).toBe(true)
  expect(ran.deny).toBeUndefined()
  expect(ran.context).toBeUndefined()
  expect(world.rows).toHaveLength(BASE.length + 1)
})

test('el escaneo periódico no corre ps mientras no haya procesos propios', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [], killed: [] }
  const { clock } = installEngine(on, world)
  await start($)
  const afterStart = world.psRuns

  await clock.advance(90_000)

  expect(world.psRuns).toBe(afterStart)
})

test('al cerrar la sesión mata lo propio salvo que killAtSessionEnd esté apagado', { options: { killAtSessionEnd: false } }, async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [DETACHED_DEV], killed: [] }
  installEngine(on, world)
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'npm run dev &' })

  await $.session.end({ reason: 'other', sessionId: SESSION, resume: { id: SESSION } })

  expect(world.killed).toEqual([])
})

test('si falla la foto previa, el Bash corre igual', async ($, on) => {
  const world: World = { rows: [...BASE], afterBash: [], killed: [], isLightPsBroken: true }
  installEngine(on, world)
  await start($)

  const ran = await $.tool.call({ tool: 'Bash', command: 'ls' })

  expect(ran.deny).toBeUndefined()
})
