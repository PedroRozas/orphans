import { expect, test } from 'claude-code/testing'

import { hostFrom, platformFromUname } from './host'

test('reconoce macOS y Linux y deja fuera el resto', () => {
  expect(platformFromUname('Darwin')).toBe('macos')
  expect(platformFromUname('Linux')).toBe('linux')
  expect(platformFromUname('MINGW64_NT-10.0')).toBe('unsupported')
  expect(platformFromUname('')).toBe('unsupported')
})

test('sin ps o kill el host queda sin soporte; lsof es opcional', () => {
  expect(hostFrom('Linux', { ps: '/usr/bin/ps', kill: '/usr/bin/kill', lsof: null })).toEqual({
    platform: 'linux',
    uname: 'Linux',
    tools: { ps: '/usr/bin/ps', kill: '/usr/bin/kill', lsof: null },
  })
  expect(hostFrom('Darwin', { ps: null, kill: '/bin/kill', lsof: '/usr/sbin/lsof' }).tools).toBeNull()
  expect(hostFrom('MINGW64_NT-10.0', { ps: '/bin/ps', kill: '/bin/kill', lsof: null }).platform).toBe('unsupported')
})
