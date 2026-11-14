export type Deliver = 'fill' | 'submit'

export type Config = {
  deliver: Deliver
  compactInstructions: string
  copyToClipboard: boolean
  /** Where handoff notes go; empty for the system temp directory's claude-relay/. */
  noteDir: string
  /** Replaces the save turn's first step; empty for the default (update stale docs in place). */
  saveInstructions: string
  /** A file whose text replaces compactInstructions; empty for none. A leading ~ is the home directory. */
  instructionsFile: string
  /** Fill the box as compaction starts (true) or once it has finished (false). */
  fillDuringCompaction: boolean
  /** A handoff the agent starts by itself is declined below this context size. */
  minTokens: number
}

/**
 * Background deliveries (task notifications, other sessions' and teammates'
 * messages) held from the handoff until the continuation prompt, which
 * carries them, and until that prompt's turn starts.
 */
export type Hold = {
  isHolding: boolean
  /** The held deliveries' text, in arrival order. */
  items: string[]
  /**
   * The person's prompt took what was held; the hold lasts until its turn
   * starts, and what arrives in between is resubmitted then.
   */
  endsAtTurn: boolean
  /** Bumped when the hold starts or is released, so a late rollback can't revive a hold that ended. */
  gen: number
  /**
   * Set when a run the person started stopped without compacting: the
   * person's next prompt carries it to the model, which had been told a
   * compaction was coming.
   */
  notice: string | null
}

/**
 * idle: nothing running. saving: /relay submitted the save prompt and the
 * handoff tool hasn't been called. armed: the tool saved the note and prompt;
 * waiting for that turn to end. continuing: compacting, then delivering.
 */
export type Phase = 'idle' | 'saving' | 'armed' | 'continuing'

/** Who started the run: the person with /relay, or the agent calling the tool by itself. */
export type Source = 'person' | 'agent'

export type Run = {
  phase: Phase
  /** Bumped on every start and cancel, so a stale continuation stops itself. */
  runId: number
  /** The save turn's id, once its turn.start is seen (a /relay run). */
  saveTurnId: string | null
  startedAt: number | null
  /** Where the handoff note is written. */
  notePath: string | null
  source: Source
  /** How many times compaction waited for a turn that started first. */
  deferrals: number
  /** A turn ran between the note and the compaction, so the prompt says the summary is newer. */
  isStale: boolean
  /**
   * A handoff call is refused until the next main-loop turn starts: /relay
   * was cancelled or stopped by the person's prompt, and the save prompt still
   * in front of the model would otherwise start a run of its own.
   */
  isBlocked: boolean
}

/**
 * A run in progress, kept in $.store under `run/<session id>` until the run
 * ends. `$.state` and timers die with the process, so a new process that
 * finds one reports the run as lost.
 */
export type RunRecord = {
  /** armed and continuing: the note and the continuation prompt are on disk. */
  phase: 'saving' | 'armed' | 'continuing'
  notePath: string
  startedAt: number
  /** Absent on records an older version wrote: the person's. */
  source?: Source
}

/** The last continuation prompt, kept in $.store across sessions for /relay paste. */
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
    relay: { run: Shaped<Run>; hold: Shaped<Hold> }
  }
}
