export type HudSegment = 'rtk' | 'turn' | 'git' | 'skill' | 'agents'
export type HudRtk = { commands: number; input: number; saved: number }
export type HudRtkTrend = { perTurn: number[]; savedAtTurnStart: number; top: Record<string, number> }
export type HudTurn = { startedAt: number | null; tools: number; lastMs: number | null; lastTools: number }
export type HudToolMix = { current: Record<string, number>; last: Record<string, number> }
export type HudSessionStats = { turns: number; tools: number }
export type HudGit = { branch: string; changed: number; ahead: number; behind: number; files?: string[] }
export type HudAgent = {
  id: string
  type: string
  description: string
  status: string
  parentId: string | null
  seenAt: number
  endedAt: number | null
  tools: number
  lastTool: string | null
}
export type HudCheckpoint = {
  status: 'idle' | 'running' | 'saved' | 'failed'
  startedAt: number | null
  endedAt: number | null
  path: string | null
  error: string | null
}
export type HudAgents = { running: number; list?: HudAgent[] }

declare module 'claude-code' {
  interface PluginState {
    'neon-hud': {
      rtk: HudRtk
      rtkTrend: HudRtkTrend
      rtkAllTime: number | null
      turn: HudTurn
      toolMix: HudToolMix
      stats: HudSessionStats
      git: HudGit | null
      skill: string | null
      skillHistory: string[]
      agents: HudAgents
      checkpoint: HudCheckpoint
      hidden: HudSegment[]
    }
  }
}
