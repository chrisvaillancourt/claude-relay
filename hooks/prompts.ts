import type { Command, Deliver, Hold, RunRecord } from '../types'

/** Leads the save prompt, so the save turn can be told apart by its text. */
export const SAVE_MARKER = '[relay] Checkpoint before compaction.'

/** The tool's short name, and the name the model calls it by. */
export const TOOL_NAME = 'handoff'
export const TOOL = `mcp__relay__${TOOL_NAME}`

/**
 * Where the handoff note goes: `dir` (default: the system temp directory's
 * claude-relay/), named for the project and the UTC time the run started.
 */
export function notePathFor(dir: string, projectRoot: string, nowMs: number): string {
  const project = (projectRoot.replace(/\/+$/, '').split('/').pop() || 'session').replace(/[^A-Za-z0-9._-]/g, '-')
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${dir.replace(/\/+$/, '')}/${project}-${stamp}.md`
}

/** Where the continuation prompt is kept: beside its note, so it can be compared with what was sent. */
export function promptPathFor(notePath: string): string {
  return /\.md$/.test(notePath) ? notePath.replace(/\.md$/, '.prompt.md') : `${notePath}.prompt.md`
}

export const TOOL_DESCRIPTION =
  'Hand the work off to yourself across a compaction, so a long conversation does not carry detail it no longer needs. ' +
  'relay saves your handoff note to a file, compacts the conversation when this turn ends, and then continues from the continuation prompt you give now. ' +
  'Call it at a logical stopping point when the context is large and work remains, or when a [relay] save prompt asks. ' +
  'Before calling, update the docs, notes and tickets this session made stale and commit what you mean to commit, so the note can link to them instead of repeating them. ' +
  'The note is final once you call: after the call, end your turn with a one-line status, make no more tool calls and start no new work in this turn. ' +
  'The same session and process continue after the compaction, so subagents and background jobs keep running and still report. ' +
  "Don't call it on your own when the task is nearly done or while you are waiting on the user."

export const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    note: {
      type: 'string',
      description:
        'The handoff note, in Markdown. Record: what is done; what is in progress and exactly where it stands (branches, uncommitted changes, open PRs); ' +
        "decisions and why; the user's standing instructions and approvals still in force, in their words; what you learned; issues, gotchas and workarounds; " +
        'next steps, each with a disposition (do / skip / defer); the files you wrote or updated; and every subagent, background session and background job still running, ' +
        "each with its id or name, what it is doing (and which files it may be editing) and how it reports back. Link to what's already durable instead of repeating it.",
    },
    continuation: {
      type: 'string',
      description:
        'The prompt that restarts the work after the compaction: a line or two saying what to continue and the first step, ' +
        "plus anything the agent must know that the note and the files don't say. relay adds the note's path and the files list.",
    },
    files: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Paths of the files to read first after the compaction; relay lists the note itself. ' +
        'Leave out instruction files such as AGENTS.md and CLAUDE.md, which the harness loads.',
    },
  },
  required: ['note', 'continuation'],
} as const

export type Handoff = { note: string; continuation: string; files: string[] }

/** The tool call's arguments, or what to tell the model when they can't be used. */
export function parseHandoff(input: Record<string, unknown>): Handoff | { error: string } {
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  const continuation = typeof input.continuation === 'string' ? input.continuation.trim() : ''
  if (!note || !continuation) {
    return { error: 'Nothing was saved: `note` and `continuation` must both be non-empty strings. Call the tool again with both.' }
  }
  const files = Array.isArray(input.files)
    ? input.files.filter((f): f is string => typeof f === 'string').map(f => f.trim().replace(/^@/, '')).filter(Boolean)
    : []
  return { note, continuation, files }
}

/** The save turn's default first step, which the `saveInstructions` option replaces. */
export const DEFAULT_SAVE_STEP =
  "Update the project's docs and notes that this session's work made stale, in place, following CLAUDE.md / AGENTS.md. Don't create a handoff note in the project."

/**
 * The save turn's prompt: update stale docs (or follow `saveInstructions`),
 * then call the handoff tool, which holds the note's and prompt's own guidance.
 */
export function savePrompt(focus: string, saveInstructions = ''): string {
  const lines = [
    `${SAVE_MARKER} The conversation will be compacted after this turn and then continues in this same session and process, starting from what you leave now. Subagents, background sessions and background jobs you started keep running through the compaction and still report when they finish.`,
    '',
    `1. ${saveInstructions.trim() || DEFAULT_SAVE_STEP}`,
    `2. Then call the ${TOOL} tool (load it with ToolSearch if it isn't loaded) with the handoff note and the continuation prompt, as its description asks. relay saves both to files; don't write a handoff note file yourself.`,
    '3. Once the tool answers, end the turn with a one-line status.',
    '',
    "Don't start new work.",
  ]
  if (focus) lines.push('', `Focus: ${focus}`)
  return lines.join('\n')
}

/** Follows the files in every continuation prompt: what a compaction does and doesn't end. */
export const SURVIVORS_NOTE =
  'Compaction kept this session and process, so the subagents, background sessions and background jobs the note lists are still running and still report. ' +
  'Check ListAgents and the task list before treating one as dead or relaunching it; never infer that from uncommitted files or missing commits.'

/** Added when a turn ran between the note and the compaction. */
export const STALE_NOTE =
  'A message arrived and a turn ran after this note was written, before the compaction. The compaction summary covers that turn; where the two differ, the summary is newer.'

/**
 * The continuation prompt as delivered: the agent's own text, the files to
 * read (`@path`, the note first), and what relay knows about the compaction.
 */
export function composeContinuation(handoff: Pick<Handoff, 'continuation' | 'files'>, notePath: string, isStale = false): string {
  const files = [notePath, ...handoff.files.filter(f => f !== notePath)]
  const unique = files.filter((f, i) => files.indexOf(f) === i)
  const parts = [handoff.continuation, `Come up to speed:\n${unique.map(f => `@${f}`).join('\n')}`, SURVIVORS_NOTE]
  if (isStale) parts.push(STALE_NOTE)
  return parts.join('\n\n')
}

/**
 * What the compaction is asked to keep: the person's instructions, then that
 * the note is on disk, so the summary needn't carry what the note already does.
 */
export function compactInstructionsFor(base: string, notePath: string): string {
  return (
    `${base}\n\n` +
    `A handoff note is saved at ${notePath}, and the agent reads it again right after this compaction. ` +
    'Keep the summary short where the note already covers something. ' +
    "Keep in full the user's standing instructions, anything the note leaves out, and anything that happened after the note was written."
  )
}

/** How every accepted handoff tells the model to stop: work after the call is in no note. */
const END_TURN =
  'The note is final: nothing you do after this call is in it. End your turn now with a one-line status; make no more tool calls and start no new work in this turn.'

/** The tool's answer once the note and prompt are saved. */
export function acceptedText(notePath: string, deliver: Deliver): string {
  const then = deliver === 'submit' ? 'sends the continuation prompt' : "puts the continuation prompt in the person's prompt box"
  return (
    `Handoff saved to ${notePath}. ${END_TURN} ` +
    `relay compacts the conversation when this turn ends, then ${then}.`
  )
}

/** The answer when the call replaced the note of a run still waiting to compact: this turn ran after the first note. */
export function replacedText(notePath: string, deliver: Deliver): string {
  const then = deliver === 'submit' ? 'sends the continuation prompt' : "puts the continuation prompt in the person's prompt box"
  return (
    `Handoff saved to ${notePath}, in place of the one saved before this turn, which had not been compacted yet. ${END_TURN} ` +
    `relay compacts the conversation when this turn ends, then ${then}.`
  )
}

/**
 * The answer when the person typed a prompt over the turn and the model may
 * not have read it yet: a handoff now would be written without it.
 */
export const UNSEEN_TEXT =
  'Nothing was saved: the person sent a prompt during this turn that you may not have read when you wrote this handoff. ' +
  'It reaches you with this result or right after it. Act on it first; then, if handing off is still right, call the tool again with a note that covers it.'

/** Added to an answer that starts no run while an earlier run's continuation prompt is still queued. */
export const QUEUED_NOTE =
  "An earlier handoff's continuation prompt is still queued and arrives when this turn ends. It was written before this turn's work: where it differs from what you have done since, it is out of date."

/** Added to a continuation whose run replaced one with a prompt still queued, which relay then cut short. */
export function supersededLine(oldNotePath: string): string {
  return `An earlier continuation prompt, the one naming ${oldNotePath}, was queued before this handoff and is out of date: ignore it. This prompt replaces it, and repeats below any messages it carried.`
}

export function belowMinText(tokens: number, minTokens: number): string {
  return `Nothing was saved: the context is ${tokens} tokens, under relay's ${minTokens}-token floor for a handoff you start yourself, so a compaction would cost more than it saves. Keep working.`
}

export const SUBAGENT_TEXT = "Nothing was saved: only the main conversation can hand off. Keep working, and report to the agent that started you as usual."
export const ALREADY_TEXT = 'A handoff is already saved and waiting for this turn to end. End your turn with a one-line status.'
export const CANCELLED_TEXT = 'No handoff will run: the person cancelled it or sent a prompt of their own, and the conversation will NOT be compacted. End your turn with a one-line status.'
export const UNSAVED_TEXT = "Nothing was saved: relay couldn't record the handoff. Keep working, and try again at the next stopping point."

/**
 * The note with a `Session: <id>` line, so a later session can find this
 * one's transcript. A note that already names this session is left alone;
 * a `Session:` line copied from an earlier note doesn't count.
 */
export function withSession(note: string, sessionId: string): string {
  const named = note.split(/\r?\n/).some(line => line.startsWith('Session: ') && line.includes(sessionId))
  return named ? note : `${note}\n\nSession: ${sessionId}`
}

export const RUN_KEY_PREFIX = 'run/'

/** Where a run in progress is kept in `$.store`, one key per session, so a new process can tell it was lost. */
export function runKey(sessionId: string): string {
  return `${RUN_KEY_PREFIX}${sessionId}`
}

/** Where a session's held deliveries are kept in `$.store`, so a new process can hand them back. */
export function heldKey(sessionId: string): string {
  return `held/${sessionId}`
}

export function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    (v.phase === 'saving' || v.phase === 'armed' || v.phase === 'continuing') &&
    typeof v.notePath === 'string' &&
    typeof v.startedAt === 'number'
  )
}

function clockTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`
}

/**
 * What to say when a run was lost with its timers: a new process (an
 * upgrade, a background session moved to another host, a crash and resume) or
 * a plugin reload found a run its predecessor didn't finish. Read by the
 * person in the log, and by the model when the agent started the run.
 */
export function lostRunNotice(record: RunRecord, cause: 'restart' | 'reload'): string {
  const what = cause === 'restart' ? 'Claude Code restarted this session' : 'a plugin reload came'
  const which = `the relay handoff started at ${clockTime(record.startedAt)}`
  if (record.phase === 'saving') {
    return `stopped: ${what} during the save turn of ${which}, so the run was lost. Nothing was saved or compacted; /relay to start over.`
  }
  if (record.phase === 'armed') {
    return (
      `stopped: ${what} before the turn of ${which} ended, so the run was lost. The conversation was NOT compacted. ` +
      `The handoff note is at ${record.notePath}. Carry on, and hand off again (/relay, or the ${TOOL} tool) at the next stopping point.`
    )
  }
  return (
    `stopped: ${what} while ${which} was compacting, so the run was lost and the conversation may not have been compacted. ` +
    `The handoff note is at ${record.notePath} and the continuation prompt at ${promptPathFor(record.notePath)}: read both and continue from them. ` +
    'If the conversation is still long, hand off again at the next stopping point.'
  )
}

/**
 * What the model is told when a run stopped without compacting, since the
 * tool's answer had promised a compaction and nothing else would correct it.
 */
export function notCompactedNotice(reason: string, notePath: string | null): string {
  return (
    `relay: the handoff stopped, so this conversation was NOT compacted. ${reason}` +
    (notePath ? ` The handoff note, if it was saved, is at ${notePath}.` : '') +
    ` Carry on from where things stand, and hand off again (the ${TOOL} tool) at the next stopping point if the context is still large.`
  )
}

/**
 * Deliveries that start a turn on their own: background tasks, other
 * sessions, schedules. Held from the handoff until the continuation prompt's
 * turn starts, so none runs between the two. Not `channel`: that may be the
 * person driving the session remotely, who couldn't end a hold from there.
 * Not `unclassified`: a person's unstamped command shares it. A teammate's
 * message raises no `prompt.submit` at all; it is held at `session.receive`.
 */
const HELD_ORIGINS = new Set([
  'task-notification',
  'peer',
  'peer-send-message',
  'projects-relay',
  'coordinator',
  'observer',
  'observer-activity',
  'scheduled-trigger',
])

export function isHeldOrigin(kind: string): boolean {
  return HELD_ORIGINS.has(kind)
}

/** The person's own prompt, which ends the hold. */
export function isPersonOrigin(kind: string): boolean {
  return kind === 'composer' || kind === 'bridge' || kind === 'sdk' || kind === 'slack-ping'
}

/** A teammate's message as it is held: `session.receive` gives the bare text, so the sender is named here. */
export function teammateItem(teammate: string, text: string): string {
  return `Message from teammate ${teammate}:\n${text}`
}

/** The hold with `text` added, or null when it isn't holding (a release won the race), so the delivery passes. */
export function holdAppend(cur: Hold, text: string): Hold | null {
  return cur.isHolding ? { ...cur, items: [...cur.items, text] } : null
}

/**
 * The hold after a prompt that took `taken` and `notice` (when the hold was
 * at `gen`) was refused further down, or null when the hold has been released
 * or restarted since and must not be revived. A prompt that ended the hold
 * gives it back, items first; one that took nothing leaves another prompt's
 * handoff alone.
 */
export function restoreHold(cur: Hold, taken: readonly string[], gen: number, didEnd: boolean, notice: string | null = null): Hold | null {
  if ((cur.gen ?? 0) !== gen) return null
  const withNotice = { ...cur, notice: cur.notice ?? notice }
  if (!didEnd) return withNotice
  return { ...withNotice, isHolding: true, endsAtTurn: false, items: [...taken, ...cur.items] }
}

/** The held deliveries, in the order they arrived, for the prompt that ends the hold. */
export function heldNotice(items: readonly string[]): string {
  return (
    'relay held these messages while it compacted the conversation, so none would start a turn before the continuation prompt. They arrived in this order:\n\n' +
    items.join('\n\n')
  )
}

/** A plugin's submitted prompt doesn't expand `@` mentions, so the model is told to read them. */
export function forSubmit(text: string): string {
  return `${SUBMIT_LEAD}\n\n${text}`
}

/** How every continuation relay submits begins. */
export const SUBMIT_LEAD =
  'Read every file below whose path is prefixed with @ before doing anything else (they are not attached automatically), then continue.'

const UNSEEN_KEY_LENGTH = 80
/** A shorter prompt ("ok", "no") is in almost any row, so no row is taken to carry it. */
const MIN_UNSEEN_KEY_LENGTH = 12
const MAX_UNSEEN = 20

/** What a prompt typed over a turn is known by until the model has read it: the start of its text. */
export function unseenKey(text: string): string {
  return text.trim().slice(0, UNSEEN_KEY_LENGTH)
}

/** `unseen` with a prompt typed over the running turn added. */
export function withUnseen(unseen: readonly string[], text: string): string[] {
  return [...unseen, unseenKey(text)].slice(-MAX_UNSEEN)
}

/**
 * The typed-over prompts the model still hasn't read, after a queued prompt
 * was attached to the running turn with `content` as its rendering. A prompt
 * too short to be known by its text stays until a refused call or the next turn.
 */
export function stillUnseen(unseen: readonly string[], content: readonly { type?: unknown; text?: unknown }[]): string[] {
  const text = content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
  return unseen.filter(key => key.length < MIN_UNSEEN_KEY_LENGTH || !text.includes(key))
}

/**
 * Whether a compaction rejection means the person cancelled it (Esc or
 * Ctrl+C). Claude Code 2.1.294 rejects with "Compaction canceled.".
 */
export function isCanceled(message: string): boolean {
  return /\bcancel(?:l?ed)?\b/i.test(message)
}

export function parseArgs(args: string): Command {
  const trimmed = args.trim()
  switch (trimmed.toLowerCase()) {
    case 'status':
      return { kind: 'status' }
    case 'cancel':
      return { kind: 'cancel' }
    case 'paste':
      return { kind: 'paste' }
    default:
      return { kind: 'start', focus: trimmed }
  }
}
