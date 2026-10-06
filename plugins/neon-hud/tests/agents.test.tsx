import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

const fleet: AgentInfo[] = [
  { id: 'a1', type: 'general-purpose', description: 'research hud api', status: 'running' },
  { id: 'a2', type: 'Explore', description: 'find types', status: 'running', parentId: 'a1' },
  { id: 'a3', type: 'Plan', description: 'draft plan', status: 'completed' },
]

// Everything the hud asks of the engine, answered from memory
function engine(on: On, now = 1_000_000) {
  const clock = mock.clock(on, { now })
  on('agent.list', () => ({ value: fleet }))
  on('env.get', () => ({ value: undefined }) as never)
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '' } }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  return clock
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`agents: ${surface} shows the running count`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

    const ui = await $.ui.mount({ plugin: 'neon-hud', surface, component: 'AbovePrompt', props: {} as never })
    expect((await ui.find({ key: 'pill-agents' }))?.text).toMatch(/2 running\s+1 done/)
  })
}

for (const surface of ['terminal', 'desktop'] as const) test(`agents: ${surface} draws the fleet as a tree, child under its parent`, async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/tmp', surface, isInteractive: true })

  // A subagent's tool call is credited to its row
  await $.tool.call({ tool: 'Read', file_path: '/tmp/x', agentId: 'a2' } as never).catch(() => {})

  const ui = await $.ui.mount({ plugin: 'neon-hud', surface, component: 'AbovePrompt', props: {} as never })
  const rows = await ui.findAll({ type: 'Box' })
  expect(rows.map(r => r.key).filter(k => k?.startsWith('agent-'))).toEqual(['agent-a1', 'agent-a2', 'agent-a3'])
  expect((await ui.find({ key: 'agent-a2' }))?.text).toMatch(/└ ◴ Explore.*1 call.*Read/)
  expect((await ui.find({ key: 'agent-a3' }))?.text).toMatch(/✓ Plan.*completed/)

  // A finished agent drops out of the tree after its linger
  // An agent that stops reads as waiting until it settles, then as done
  fleet[1] = { ...fleet[1]!, status: 'completed' }
  await clock.advance(3_000)
  expect((await ui.find({ key: 'agent-a2' }))?.text).toMatch(/◌ Explore.*waiting/)
  await clock.advance(9_000)
  expect((await ui.find({ key: 'agent-a2' }))?.text).toMatch(/✓ Explore.*completed/)
  expect((await ui.find({ key: 'pill-agents' }))?.text).toMatch(/1 running\s+2 done/)
  fleet[1] = { ...fleet[1]!, status: 'running' }

  await clock.advance(61_000)
  expect(await ui.find({ key: 'agent-a3' })).toBeUndefined()
})
