import type { ProcessIdentity } from '../types'

export type Language = 'en' | 'es'

export type Messages = {
  command: string
  commandDescription: string
  argumentHint: string
  killWord: string
  status: (count: number) => string
  leftoversToast: (count: number) => string
  unsupported: (uname: string) => string
  nothingForgotten: string
  forgottenHeader: string
  leftoversHeader: string
  pidNotForgotten: (pid: string) => string
  terminated: (killed: number, total: number) => string
  stillAlive: (line: string) => string
  question: (fresh: readonly ProcessIdentity[]) => string
}

export const describeProcess = (identity: ProcessIdentity): string =>
  `${identity.pid}  ${identity.command.slice(0, 100)}`

const pidsOf = (fresh: readonly ProcessIdentity[]): string => fresh.map(identity => identity.pid).join(' ')

const lines = (fresh: readonly ProcessIdentity[]): string[] => fresh.map(identity => `  ${describeProcess(identity)}`)

const MESSAGES: Readonly<Record<Language, Messages>> = {
  en: {
    command: 'orphans',
    commandDescription: 'Lists or ends the processes Claude left running (kill [pid])',
    argumentHint: '[kill [pid]]',
    killWord: 'kill',
    status: count => `${count} background process${count === 1 ? '' : 'es'} · /orphans`,
    leftoversToast: count => `${count} process${count === 1 ? '' : 'es'} from earlier Claude sessions still alive · /orphans`,
    unsupported: uname => `orphans: unsupported host (${uname || 'unknown'}); process tracking is off`,
    nothingForgotten: 'No processes left running by Claude.',
    forgottenHeader: 'Running in the background in this session:',
    leftoversHeader: 'From earlier sessions that already ended:',
    pidNotForgotten: pid => `PID ${pid} is not among the forgotten processes.`,
    terminated: (killed, total) => `Ended: ${killed} of ${total}.`,
    stillAlive: line => `Still alive: ${line}`,
    question: fresh =>
      [
        fresh.length === 1
          ? 'orphans: this command left a process running outside the shell:'
          : `orphans: ${fresh.length} processes were left running outside the shell:`,
        ...lines(fresh),
        fresh.length === 1
          ? `If you no longer need it, end it now with \`kill ${pidsOf(fresh)}\`. If you need it for what comes next, leave it: you will not be asked again and it ends by itself when the session ends.`
          : `If you no longer need them, end them now with \`kill ${pidsOf(fresh)}\` (or only the ones you can spare). The ones you leave will not be asked about again and end by themselves when the session ends.`,
      ].join('\n'),
  },
  es: {
    command: 'huerfanos',
    commandDescription: 'Lista o mata los procesos que Claude dejó corriendo (matar [pid])',
    argumentHint: '[matar [pid]]',
    killWord: 'matar',
    status: count => `${count} proceso${count === 1 ? '' : 's'} en segundo plano · /huerfanos`,
    leftoversToast: count => `Hay ${count} proceso${count === 1 ? '' : 's'} de sesiones anteriores de Claude vivo${count === 1 ? '' : 's'} · /huerfanos`,
    unsupported: uname => `huerfanos: sistema no soportado (${uname || 'desconocido'}); el control de procesos queda apagado`,
    nothingForgotten: 'No hay procesos olvidados por Claude.',
    forgottenHeader: 'En segundo plano en esta sesión:',
    leftoversHeader: 'De sesiones anteriores que ya terminaron:',
    pidNotForgotten: pid => `El PID ${pid} no está entre los procesos olvidados.`,
    terminated: (killed, total) => `Terminados: ${killed} de ${total}.`,
    stillAlive: line => `Sigue vivo: ${line}`,
    question: fresh =>
      [
        fresh.length === 1
          ? 'huerfanos: este comando dejó un proceso corriendo fuera de la shell:'
          : `huerfanos: quedaron ${fresh.length} procesos corriendo fuera de la shell:`,
        ...lines(fresh),
        fresh.length === 1
          ? `Si ya no lo necesitas, termínalo ahora con \`kill ${pidsOf(fresh)}\`. Si lo necesitas para lo que sigue, déjalo: no se volverá a preguntar y se cierra solo al terminar la sesión.`
          : `Si ya no los necesitas, termínalos ahora con \`kill ${pidsOf(fresh)}\` (o solo los que sobren). Los que dejes no se volverán a preguntar y se cierran solos al terminar la sesión.`,
      ].join('\n'),
  },
}

export const KILL_WORDS: ReadonlySet<string> = new Set(['kill', 'matar'])

export const resolveLanguage = (value: unknown): Language => (value === 'es' ? 'es' : 'en')

export const messagesFor = (language: Language): Messages => MESSAGES[language]
