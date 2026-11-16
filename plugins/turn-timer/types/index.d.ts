export type TurnTimer = { isWorking: boolean; isWaitingOnCodex: boolean; seconds: number }
export type Codex = { text: string } | null

declare module 'claude-code' {
  interface PluginState {
    'turn-timer': { timer: TurnTimer | null; codex: Codex }
  }
}
