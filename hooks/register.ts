import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Host, LedgerEntry, ProcessIdentity } from '../types'
import { TOOL_CANDIDATES, UNDETECTED, hostFrom } from './host'
import { KILL_WORDS, describeProcess, messagesFor, resolveLanguage } from './i18n'
import type { Language, Messages } from './i18n'
import {
  belongsToOtherSession,
  findForgotten,
  findLiveGroups,
  findOrphansBornBetween,
  findOwned,
  findStillAlive,
  findUnknown,
  isClaudeShell,
  parseLsofOutput,
  parsePidTable,
  parsePsOutput,
  toIdentity,
} from './processes'
import type { PidRow, ProcessRow } from './processes'

const PLUGIN = 'orphans'
const LEDGER_KEY = 'ledger'
const GRACE_BEFORE_SIGKILL_MS = 2_000
const DEFAULT_SCAN_INTERVAL_SECONDS = 30
const MIN_SCAN_INTERVAL_SECONDS = 10
const MAX_SCAN_INTERVAL_SECONDS = 600

const hostAtom = atom({ plugin: 'orphans', key: 'host' } as const, UNDETECTED)
const claudePidAtom = atom({ plugin: 'orphans', key: 'claudePid' } as const, 0)
const groupsAtom = atom({ plugin: 'orphans', key: 'groups' } as const, [])
const forgottenAtom = atom({ plugin: 'orphans', key: 'forgotten' } as const, [])
const askedAtom = atom({ plugin: 'orphans', key: 'asked' } as const, [])
const leftoversAtom = atom({ plugin: 'orphans', key: 'leftovers' } as const, [])

type Ledger = Record<string, LedgerEntry>

type Settings = {
  language: Language
  messages: Messages
  asksSession: boolean
  killsAtSessionEnd: boolean
  scanIntervalMs: number
}

type Tools = NonNullable<Host['tools']>

const resolveScanIntervalSeconds = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_SCAN_INTERVAL_SECONDS, Math.max(MIN_SCAN_INTERVAL_SECONDS, value))
    : DEFAULT_SCAN_INTERVAL_SECONDS

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const logDebug = ($: EngineInterface, where: string, error: unknown): void => {
  $.ui.log(`${PLUGIN}: ${where}: ${describeError(error)}`, { to: 'debug' })
}

const readUname = async ($: EngineInterface): Promise<string> => {
  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'])
    return exitCode === 0 ? stdout.trim() : ''
  } catch {
    return ''
  }
}

const isFile = async ($: EngineInterface, path: string): Promise<boolean> => {
  try {
    return (await $.fs.stat(path)).kind === 'file'
  } catch {
    return false
  }
}

const firstFile = async ($: EngineInterface, candidates: readonly string[]): Promise<string | null> => {
  for (const candidate of candidates) {
    if (await isFile($, candidate)) return candidate
  }
  return null
}

const detectHost = async ($: EngineInterface): Promise<Host> => {
  const uname = await readUname($)
  if (uname !== 'Darwin' && uname !== 'Linux') return hostFrom(uname, { ps: null, kill: null, lsof: null })
  const [ps, kill, lsof] = await Promise.all([
    firstFile($, TOOL_CANDIDATES.ps),
    firstFile($, TOOL_CANDIDATES.kill),
    firstFile($, TOOL_CANDIDATES.lsof),
  ])
  return hostFrom(uname, { ps, kill, lsof })
}

const readTools = async ($: EngineInterface): Promise<Tools | null> => (await read($, hostAtom)).tools

const listProcesses = async ($: EngineInterface, tools: Tools): Promise<ProcessRow[]> => {
  const { stdout } = await $.process.run([tools.ps, '-A', '-ww', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    env: { LC_ALL: 'C' },
  })
  return parsePsOutput(stdout)
}

const listPids = async ($: EngineInterface, tools: Tools): Promise<PidRow[]> => {
  const { stdout } = await $.process.run([tools.ps, '-A', '-o', 'pid=,ppid=,pgid='])
  return parsePidTable(stdout)
}

const readClaudePid = async ($: EngineInterface): Promise<number> => {
  const known = await read($, claudePidAtom)
  if (known !== 0) return known
  const { stdout } = await $.process.run(['/bin/sh', '-c', 'echo $PPID'])
  const pid = Number(stdout.trim())
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`${PLUGIN}: invalid Claude PID: ${stdout}`)
  await update($, claudePidAtom, () => pid)
  return pid
}

const readLedger = async ($: EngineInterface): Promise<Ledger> => ((await $.store.get(LEDGER_KEY)) ?? {}) as Ledger

const ledgerKeyOf = (claude: ProcessRow): string => `${claude.pid}@${claude.startedAt}`

const excludeOtherSessions = async ($: EngineInterface, tools: Tools, orphans: ProcessRow[]): Promise<ProcessRow[]> => {
  if (orphans.length === 0 || tools.lsof === null) return orphans
  const sessionId = await $.session.id()
  const { stdout } = await $.process.run([
    tools.lsof,
    '-nP',
    '-w',
    '-a',
    '-d',
    '1,2',
    '-Fn',
    '-p',
    orphans.map(row => row.pid).join(','),
  ])
  const pathsByPid = parseLsofOutput(stdout)
  return orphans.filter(row => !belongsToOtherSession(pathsByPid.get(row.pid) ?? [], sessionId))
}

const reportStatus = ($: EngineInterface, messages: Messages, forgotten: readonly ProcessIdentity[]): void => {
  $.ui.status(forgotten.length === 0 ? undefined : messages.status(forgotten.length))
}

const scan = async ($: EngineInterface, settings: Settings, tools: Tools, rows?: ProcessRow[]): Promise<ProcessIdentity[]> => {
  const claudePid = await readClaudePid($)
  const current = rows ?? (await listProcesses($, tools))
  const shellGroups = current.filter(row => isClaudeShell(row, claudePid)).map(row => row.pid)
  const groups = await update($, groupsAtom, known => findLiveGroups(current, new Set([...known, ...shellGroups])))
  const owned = findOwned(current, new Set(groups), claudePid)
  const forgotten = findForgotten(current, owned, claudePid).map(toIdentity)
  await update($, forgottenAtom, () => forgotten)
  reportStatus($, settings.messages, forgotten)

  const claude = current.find(row => row.pid === claudePid)
  if (claude !== undefined) {
    const ledger = await readLedger($)
    const processes = owned.filter(row => !isClaudeShell(row, claudePid)).map(toIdentity)
    const { [ledgerKeyOf(claude)]: _previous, ...others } = ledger
    await $.store.set(
      LEDGER_KEY,
      processes.length === 0
        ? others
        : { ...others, [ledgerKeyOf(claude)]: { claudePid, claudeStartedAt: claude.startedAt, processes } },
    )
  }
  return forgotten
}

const takeUnasked = async ($: EngineInterface, forgotten: readonly ProcessIdentity[]): Promise<ProcessIdentity[]> => {
  const asked = await read($, askedAtom)
  const fresh = findUnknown(forgotten, asked)
  await update($, askedAtom, () => [...forgotten])
  return fresh
}

const askSession = async ($: EngineInterface, settings: Settings, fresh: readonly ProcessIdentity[]): Promise<void> => {
  if (fresh.length === 0) return
  await $.session.append({
    message: { type: 'user', content: [{ type: 'text', text: settings.messages.question(fresh) }] },
  })
}

const scanAndAsk = async ($: EngineInterface, settings: Settings, tools: Tools): Promise<void> => {
  if ((await read($, groupsAtom)).length === 0) return
  const forgotten = await scan($, settings, tools)
  if (!settings.asksSession) return
  await askSession($, settings, await takeUnasked($, forgotten))
}

const collectLeftovers = async ($: EngineInterface, tools: Tools): Promise<ProcessIdentity[]> => {
  const rows = await listProcesses($, tools)
  const ledger = await readLedger($)
  const kept: Ledger = {}
  const leftovers: ProcessIdentity[] = []
  for (const [key, entry] of Object.entries(ledger)) {
    const claudeAlive = findStillAlive(rows, [{ pid: entry.claudePid, startedAt: entry.claudeStartedAt, command: '' }])
    const alive = findStillAlive(rows, entry.processes)
    if (claudeAlive.length > 0) kept[key] = entry
    else if (alive.length > 0) {
      kept[key] = { ...entry, processes: alive }
      leftovers.push(...alive)
    }
  }
  await $.store.set(LEDGER_KEY, kept)
  await update($, leftoversAtom, () => leftovers)
  return leftovers
}

const signal = async ($: EngineInterface, tools: Tools, name: 'TERM' | 'KILL', pids: readonly number[]): Promise<void> => {
  if (pids.length === 0) return
  await $.process.run([tools.kill, `-${name}`, ...pids.map(String)])
}

const terminate = async ($: EngineInterface, tools: Tools, targets: readonly ProcessIdentity[]): Promise<ProcessIdentity[]> => {
  const alive = findStillAlive(await listProcesses($, tools), targets)
  await signal($, tools, 'TERM', alive.map(target => target.pid))
  await $.clock.sleep(GRACE_BEFORE_SIGKILL_MS)
  const stubborn = findStillAlive(await listProcesses($, tools), alive)
  await signal($, tools, 'KILL', stubborn.map(target => target.pid))
  return findStillAlive(await listProcesses($, tools), alive)
}

const listingText = (messages: Messages, forgotten: readonly ProcessIdentity[], leftovers: readonly ProcessIdentity[]): string => {
  if (forgotten.length === 0 && leftovers.length === 0) return messages.nothingForgotten
  const sections = [
    forgotten.length > 0 ? [messages.forgottenHeader, ...forgotten.map(describeProcess)].join('\n') : '',
    leftovers.length > 0 ? [messages.leftoversHeader, ...leftovers.map(describeProcess)].join('\n') : '',
  ]
  const hint = `/${messages.command} ${messages.killWord}  ·  /${messages.command} ${messages.killWord} <pid>`
  return [...sections.filter(Boolean), `\n${hint}`].join('\n\n')
}

const runKill = async ($: EngineInterface, settings: Settings, tools: Tools, pidArgument: string): Promise<string> => {
  const candidates = [...(await scan($, settings, tools)), ...(await collectLeftovers($, tools))]
  const targets = pidArgument === '' ? candidates : candidates.filter(target => String(target.pid) === pidArgument)
  if (targets.length === 0) {
    return pidArgument === '' ? settings.messages.nothingForgotten : settings.messages.pidNotForgotten(pidArgument)
  }
  const survivors = await terminate($, tools, targets)
  await scan($, settings, tools)
  await collectLeftovers($, tools)
  return [
    settings.messages.terminated(targets.length - survivors.length, targets.length),
    ...survivors.map(survivor => settings.messages.stillAlive(describeProcess(survivor))),
  ].join('\n')
}

const runCommand = async ($: EngineInterface, settings: Settings, args: string): Promise<string> => {
  const tools = await readTools($)
  if (tools === null) return settings.messages.unsupported((await read($, hostAtom)).uname)
  const [action = '', pidArgument = ''] = args.trim().split(/\s+/)
  if (KILL_WORDS.has(action)) return runKill($, settings, tools, pidArgument)
  const forgotten = await scan($, settings, tools)
  const leftovers = await collectLeftovers($, tools)
  return listingText(settings.messages, forgotten, leftovers)
}

const attributeAfterBash = async (
  $: EngineInterface,
  settings: Settings,
  tools: Tools,
  before: readonly PidRow[],
): Promise<ProcessIdentity[]> => {
  const after = await listProcesses($, tools)
  const orphans = await excludeOtherSessions($, tools, findOrphansBornBetween(before, after))
  if (orphans.length > 0) {
    await update($, groupsAtom, known => [...new Set([...known, ...orphans.map(row => row.pgid)])])
  }
  const forgotten = await scan($, settings, tools, after)
  return settings.asksSession ? takeUnasked($, forgotten) : []
}

export const register: Register = (on, options) => {
  const language = resolveLanguage(options.language)
  const settings: Settings = {
    language,
    messages: messagesFor(language),
    asksSession: options.askSession !== false,
    killsAtSessionEnd: options.killAtSessionEnd !== false,
    scanIntervalMs: resolveScanIntervalSeconds(options.scanIntervalSeconds) * 1000,
  }
  const { messages } = settings

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const host = await detectHost($)
    await update($, hostAtom, () => host)
    if (language === 'es') {
      await $.command.register({
        name: 'huerfanos',
        description: messages.commandDescription,
        argumentHint: messages.argumentHint,
      })
    } else {
      await $.command.register({
        name: 'orphans',
        description: messages.commandDescription,
        argumentHint: messages.argumentHint,
      })
    }
    if (host.tools === null) {
      $.ui.log(messages.unsupported(host.uname))
      return started
    }
    const tools = host.tools
    await scan($, settings, tools)
    const leftovers = await collectLeftovers($, tools)
    if (leftovers.length > 0) $.ui.toast(messages.leftoversToast(leftovers.length))
    $.clock.every(settings.scanIntervalMs, () => void scanAndAsk($, settings, tools))
    return started
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const tools = await readTools($)
    if (tools === null) return next(e)
    const before = await listPids($, tools)
    const ran = await next(e)
    try {
      const fresh = await attributeAfterBash($, settings, tools, before)
      if (fresh.length === 0) return ran
      if (ran.deny !== undefined) {
        await askSession($, settings, fresh)
        return ran
      }
      return { ...ran, context: [...(ran.context ?? []), messages.question(fresh)] }
    } catch (error) {
      logDebug($, 'after Bash', error)
      return ran
    }
  }).catch(($, e, next) => {
    logDebug($, 'Bash hook', next.error)
    return next(e)
  })

  on('command.run', { command: 'orphans' }, async ($, e) => ({ text: await runCommand($, settings, e.args) }))

  on('command.run', { command: 'huerfanos' }, async ($, e) => ({ text: await runCommand($, settings, e.args) }))

  on('session.end', async ($, e, next) => {
    const tools = await readTools($)
    if (tools === null || !settings.killsAtSessionEnd) return next(e)
    const claudePid = await readClaudePid($)
    const rows = await listProcesses($, tools)
    const groups = new Set(await read($, groupsAtom))
    const owned = findOwned(rows, groups, claudePid).filter(row => !isClaudeShell(row, claudePid))
    await signal($, tools, 'TERM', owned.map(row => row.pid))
    return next(e)
  })
}
