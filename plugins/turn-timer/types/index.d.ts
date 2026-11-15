export type Timer = { isWorking: boolean; seconds: number }
export type Codex = { text: string } | null

declare module 'claude-code' {
  interface PluginState {
    'turn-timer': { timer: Timer | null; codex: Codex }
  }
}
