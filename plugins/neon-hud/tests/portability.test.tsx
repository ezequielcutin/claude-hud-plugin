import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const fleet: AgentInfo[] = [{ id: 'a1', type: 'Explore', description: 'find types', status: 'running' }]

// A machine described by which files exist; rtk answers `gain` with a total
function machine(on: On, files: string[]) {
  mock.clock(on, { now: 1_000_000 })
  const ran: string[][] = []
  on('fs.stat', (_, e) =>
    files.includes(e.path)
      ? ({ value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } as never)
      : ({ error: { code: 'ENOENT', message: `no such file: ${e.path}` } } as never),
  )
  on('process.run', (_, e) => {
    ran.push([...e.argv])
    return e.argv.includes('gain')
      ? ({ value: { exitCode: 0, stdout: '{"summary":{"total_saved":1234567}}', stderr: '' } } as never)
      : ({ value: { exitCode: 1, stdout: '', stderr: '' } } as never)
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/dev' : undefined }) as never)
  on('agent.list', () => ({ value: fleet }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  return { ran }
}

const RTK_ON_LINUX = ['/usr/local/bin/rtk', '/usr/bin/sqlite3', '/usr/bin/git', '/home/dev/.local/share/rtk/history.db']

for (const surface of ['terminal', 'desktop'] as const) {
  test(`portability: ${surface} without rtk hides the rtk segment and keeps the rest`, async ($, on) => {
    machine(on, ['/usr/bin/git'])
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'neon-hud', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.find({ key: 'pill-rtk' })).toBeUndefined()
    expect(await ui.find({ key: 'pill-agents' })).toBeDefined()

    const r = await $.command.run({ command: 'hud', args: 'rtk' } as never)
    expect(JSON.stringify(r)).toMatch(/rtk not found/)
  })

  test(`portability: ${surface} finds rtk and its database in the Linux locations`, async ($, on) => {
    const { ran } = machine(on, RTK_ON_LINUX)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    expect(ran).toContainEqual(['/usr/local/bin/rtk', 'gain', '--format', 'json'])
    const ui = await $.ui.mount({ plugin: 'neon-hud', surface, component: 'AbovePrompt', props: {} as never })
    expect(await ui.find({ key: 'pill-rtk' })).toBeDefined()
  })
}

test('portability: rtk_path and rtk_db settings win, with ~ expanded', { options: { rtk_path: '~/bin/rtk', rtk_db: '~/data/rtk.db' } }, async ($, on) => {
  const { ran } = machine(on, ['/home/dev/bin/rtk', '/home/dev/data/rtk.db', '/usr/bin/sqlite3', '/usr/local/bin/rtk'])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(ran).toContainEqual(['/home/dev/bin/rtk', 'gain', '--format', 'json'])
})

test('portability: hidden_segments hides a segment at start, and /hud brings it back', { options: { hidden_segments: 'agents, nonsense' } }, async ($, on) => {
  machine(on, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'neon-hud', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  expect(await ui.find({ key: 'pill-agents' })).toBeUndefined()

  const r = await $.command.run({ command: 'hud', args: 'agents' } as never)
  expect(JSON.stringify(r)).toMatch(/agents shown/)
  expect(await ui.find({ key: 'pill-agents' })).toBeDefined()
})
