import type { Host, Platform } from '../types'

export const TOOL_CANDIDATES = {
  ps: ['/bin/ps', '/usr/bin/ps'],
  kill: ['/bin/kill', '/usr/bin/kill'],
  lsof: ['/usr/sbin/lsof', '/usr/bin/lsof'],
} as const

export const UNDETECTED: Host = { platform: 'unsupported', uname: '', tools: null }

export const platformFromUname = (uname: string): Platform => {
  if (uname === 'Darwin') return 'macos'
  if (uname === 'Linux') return 'linux'
  return 'unsupported'
}

export const hostFrom = (
  uname: string,
  found: { ps: string | null; kill: string | null; lsof: string | null },
): Host => {
  const platform = platformFromUname(uname)
  if (platform === 'unsupported' || found.ps === null || found.kill === null) {
    return { platform: 'unsupported', uname, tools: null }
  }
  return { platform, uname, tools: { ps: found.ps, kill: found.kill, lsof: found.lsof } }
}
