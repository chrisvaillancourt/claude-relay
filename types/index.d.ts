export type Deliver = 'fill' | 'submit'

export type Config = {
  deliver: Deliver
  compactInstructions: string
  copyToClipboard: boolean
}

/**
 * idle: nothing running. saving: the save turn was submitted and hasn't
 * ended. continuing: the save turn ended; forking, compacting, delivering.
 */
export type Phase = 'idle' | 'saving' | 'continuing'

export type Run = {
  phase: Phase
  /** Bumped on every start and cancel, so a stale continuation stops itself. */
  runId: number
  /** The save turn's id, once its turn.start is seen. */
  saveTurnId: string | null
  startedAt: number | null
}

/** The last continuation prompt, kept in $.store across sessions for /handoff paste. */
export type SavedPrompt = {
  text: string
  at: number
  sessionId: string
}

export type Command =
  | { kind: 'start'; focus: string }
  | { kind: 'status' }
  | { kind: 'cancel' }
  | { kind: 'paste' }

declare module 'claude-code' {
  interface PluginState {
    handoff: { run: Run }
  }
}
