import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const NOW = Date.UTC(2026, 9, 3, 21, 5)
const EASTERN = { options: { timezone: 'us-eastern' } }

// Everything the hud asks of the engine, answered from memory; the fork's reply and the
// files written are handed back so a test can steer the one and read the other
function engine(on: On, fork: () => unknown, now = NOW) {
  const clock = mock.clock(on, { now })
  const written: Record<string, string> = {}
  const logged: string[] = []
  on('ui.log', (_, e) => {
    logged.push(e.text)
    return { value: undefined } as never
  })
  on('agent.list', () => ({ value: [] }))
  let run = (_argv: readonly string[]): { exitCode: number; stdout: string; stderr: string } => ({ exitCode: 1, stdout: '', stderr: '' })
  on('process.run', (_, e) => ({ value: run(e.argv) }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('env.get', () => ({ value: '/Users/test' }))
  on('session.cwd', () => ({ value: '/Users/test/code/my app' }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.fork', () => ({ value: fork() }) as never)
  on('fs.write', (_, e) => {
    written[e.path] = e.text
    return { value: undefined } as never
  })
  return { clock, written, logged, setRun: (f: typeof run) => (run = f) }
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`checkpoint: ${surface} button forks the session into ~/.claude/checkpoints`, EASTERN, async ($, on) => {
    const { clock, written, logged } = engine(on, () => ({ isAnswered: true, text: '# Hud work\n## Goal\nShip it.', usage: {} }))
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'neon-hud', surface, component: 'AbovePrompt', props: {} as never })

    expect((await ui.find({ key: 'checkpoint' }))?.text).toMatch(/⟲ checkpoint/)
    await ui.press({ key: 'checkpoint' })

    const path = '/Users/test/.claude/checkpoints/2026-10-03-17-05-my-app-abcdef12.md'
    expect(Object.keys(written)).toEqual([path])
    expect(written[path]).toMatch(/^---\ncreated: 2026-10-03T17:05:00-04:00\nsession: abcdef1234567890\ncwd: \/Users\/test\/code\/my app\nmodel: claude-opus-5-5\n---\n# Hud work/)
    expect((await ui.find({ key: 'checkpoint' }))?.text).toMatch(/✓ checkpoint saved/)
    expect(logged).toContain(`checkpoint saved → ${path}`)

    // The result shows for a while, then the button reads as ready again
    await clock.advance(31_000)
    expect((await ui.find({ key: 'checkpoint' }))?.text).toMatch(/⟲ checkpoint/)
  })
}

test('checkpoint: a fork with nothing to fork reports the failure and writes nothing', async ($, on) => {
  const { written } = engine(on, () => ({ isAnswered: false, reason: 'nothing-to-fork' }))
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'neon-hud', surface: 'desktop', component: 'AbovePrompt', props: {} as never })

  await ui.press({ key: 'checkpoint' })
  expect(Object.keys(written)).toEqual([])
  expect((await ui.find({ key: 'checkpoint' }))?.text).toMatch(/✗ checkpoint failed/)
  expect((await ui.find({ key: 'detail-checkpoint' }))?.text).toMatch(/nothing-to-fork/)
})

test('checkpoint: /hud checkpoint runs it too', async ($, on) => {
  const { clock, written } = engine(on, () => ({ isAnswered: true, text: 'doc', usage: {} }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const r = await $.command.run({ command: 'hud', args: 'checkpoint' } as never)
  expect(JSON.stringify(r)).toMatch(/checkpointing/)
  // The command answers at once and the checkpoint runs on behind it
  for (let i = 0; i < 20 && Object.keys(written).length === 0; i++) await clock.advance(10)
  expect(Object.keys(written)).toHaveLength(1)
})

test('checkpoint: names files in Eastern time, EST in winter', EASTERN, async ($, on) => {
  const { written } = engine(on, () => ({ isAnswered: true, text: 'doc', usage: {} }), Date.UTC(2026, 0, 15, 3, 30))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'neon-hud', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await ui.press({ key: 'checkpoint' })
  const [path] = Object.keys(written)
  expect(path).toBe('/Users/test/.claude/checkpoints/2026-01-14-22-30-my-app-abcdef12.md')
  expect(written[path!]).toMatch(/created: 2026-01-14T22:30:00-05:00/)
})

test('checkpoint: local time comes from the system clock, with its offset', async ($, on) => {
  const { written, setRun } = engine(on, () => ({ isAnswered: true, text: 'doc', usage: {} }))
  setRun(argv =>
    argv[0] === '/bin/date'
      ? { exitCode: 0, stdout: '2026-10-03T23:05:00+0200\n', stderr: '' }
      : { exitCode: 1, stdout: '', stderr: '' },
  )
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'neon-hud', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await ui.press({ key: 'checkpoint' })
  const [path] = Object.keys(written)
  expect(path).toBe('/Users/test/.claude/checkpoints/2026-10-03-23-05-my-app-abcdef12.md')
  expect(written[path!]).toMatch(/created: 2026-10-03T23:05:00\+02:00/)
})

test('checkpoint: utc, into the configured folder', { options: { timezone: 'utc', checkpoint_dir: '~/notes/handoffs/' } }, async ($, on) => {
  const { written } = engine(on, () => ({ isAnswered: true, text: 'doc', usage: {} }))
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'neon-hud', surface: 'terminal', component: 'AbovePrompt', props: {} as never })
  await ui.press({ key: 'checkpoint' })
  const [path] = Object.keys(written)
  expect(path).toBe('/Users/test/notes/handoffs/2026-10-03-21-05-my-app-abcdef12.md')
  expect(written[path!]).toMatch(/created: 2026-10-03T21:05:00Z/)
})
