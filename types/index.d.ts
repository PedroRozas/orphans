export type ProcessIdentity = { pid: number; startedAt: string; command: string }

export type LedgerEntry = {
  claudePid: number
  claudeStartedAt: string
  processes: ProcessIdentity[]
}

export type Platform = 'macos' | 'linux' | 'unsupported'

export type HostTools = { ps: string; kill: string; lsof: string | null }

export type Host = { platform: Platform; uname: string; tools: HostTools | null }

declare module 'claude-code' {
  interface PluginState {
    orphans: {
      host: Host
      claudePid: number
      groups: number[]
      forgotten: ProcessIdentity[]
      asked: ProcessIdentity[]
      leftovers: ProcessIdentity[]
    }
  }
}
