import type { Command, Hold, RunRecord } from '../types'

/** Leads the save prompt, so the save turn can be told apart by its text. */
export const SAVE_MARKER = '[relay] Checkpoint before compaction.'

/**
 * Where the handoff note goes: `dir` (default: the system temp directory's
 * claude-relay/), named for the project and the UTC time the run started.
 */
export function notePathFor(dir: string, projectRoot: string, nowMs: number): string {
  const project = (projectRoot.replace(/\/+$/, '').split('/').pop() || 'session').replace(/[^A-Za-z0-9._-]/g, '-')
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${dir.replace(/\/+$/, '')}/${project}-${stamp}.md`
}

/** The save turn's default first step, which the `saveInstructions` option replaces. */
export const DEFAULT_SAVE_STEP =
  "Update the project's docs and notes that this session's work made stale, in place, following CLAUDE.md / AGENTS.md. Don't create a handoff note in the project."

/**
 * The save turn's prompt: update stale docs (or follow `saveInstructions`),
 * then end with the handoff note, which the plugin saves.
 */
export function savePrompt(focus: string, notePath: string, saveInstructions = ''): string {
  const lines = [
    `${SAVE_MARKER} The conversation will be compacted after this turn, and the next session starts from what you leave now.`,
    '',
    `1. ${saveInstructions.trim() || DEFAULT_SAVE_STEP}`,
    `2. Then, after your last tool call, end with the handoff note inside <handoff-note> and </handoff-note> tags, each on its own line. What's inside the tags is saved to ${notePath} for the next session; don't write that file yourself.`,
    '3. In the note, record what is done; what is in progress, exactly where it stands (branches, uncommitted changes, running jobs, open PRs); decisions and why; what you learned; issues, gotchas and workarounds; next steps, each with a disposition (do / skip / defer); and the files you wrote or updated this session.',
    "4. Link to what's already durable instead of repeating it.",
    '',
    "Don't start new work.",
  ]
  if (focus) lines.push('', `Focus: ${focus}`)
  return lines.join('\n')
}

/** The side question asked over the transcript once the save turn ends (what `/btw` would be asked). */
export const CONTINUATION_PROMPT =
  'Give me a concise, copy/paste-ready prompt to continue in the next session. ' +
  'Open with one line saying what to continue, then a line reading "Come up to speed:" and the files the next agent should read first, one per line, each path prefixed with `@`. ' +
  "The harness attaches the @ files and loads AGENTS.md, CLAUDE.md and other instruction files by itself, so don't tell the agent to read them, and don't list instruction files. " +
  "Add anything else they need to know that those files don't say, without repeating what they do. " +
  'Output only the prompt: no preamble, no wrapper formatting, no code fence.'

const OPEN_TAG = /^\s*<handoff-note>\s*$/
const CLOSE_TAG = /^\s*<\/handoff-note>\s*$/
const FENCE = /^\s*(`{3,}|~{3,})/
const INLINE_NOTE = /<handoff-note>([\s\S]*?)<\/handoff-note>/g

/**
 * Blocks between tags on lines of their own, as the save prompt asks. Tag
 * names quoted in prose don't match, and tags inside a code fence (an example
 * in a draft) belong to the note's text.
 */
function ownLineNotes(answer: string): string[] {
  const lines = answer.split(/\r?\n/)
  const notes: string[] = []
  let fence: string | null = null
  let open: number | null = null
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line)?.[1]
    if (marker) {
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null
      return
    }
    if (fence !== null) return
    if (OPEN_TAG.test(line)) open = i
    else if (CLOSE_TAG.test(line) && open !== null) {
      notes.push(lines.slice(open + 1, i).join('\n'))
      open = null
    }
  })
  return notes
}

/**
 * The note inside the save turn's <handoff-note> tags: the last block whose
 * tags sit on their own lines, else the last inline pair, else the whole message.
 */
export function extractNote(answer: string): string {
  return taggedNote(answer) ?? answer.trim()
}

/** The note inside <handoff-note> tags, as `extractNote` finds it, or null when the answer has none. */
export function taggedNote(answer: string): string | null {
  const note = ownLineNotes(answer).at(-1) ?? [...answer.matchAll(INLINE_NOTE)].at(-1)?.[1]
  return note === undefined ? null : note.trim()
}

/**
 * The note with a `Session: <id>` line, so the next session can find this
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

export function isRunRecord(value: unknown): value is RunRecord {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (v.phase === 'saving' || v.phase === 'continuing') && typeof v.notePath === 'string' && typeof v.startedAt === 'number'
}

function clockTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)}Z`
}

/**
 * What to tell the person when a new process (an upgrade, a background
 * session moved to another host, a crash and resume) finds a run its
 * predecessor didn't finish: the run's state and timers died with that process.
 */
export function restartNotice(record: RunRecord): string {
  const which = `the /relay started at ${clockTime(record.startedAt)}`
  if (record.phase === 'saving') {
    return (
      `stopped: Claude Code restarted this session during the save turn of ${which}, so the run was lost. Nothing was compacted. ` +
      `If the resumed turn ends with a handoff note, relay saves it to ${record.notePath}; otherwise /relay to start over.`
    )
  }
  return (
    `stopped: Claude Code restarted this session after the save turn of ${which}, so the run was lost. The handoff note is at ${record.notePath}. ` +
    `If the conversation wasn't compacted: /compact, then send "Continue from @${record.notePath}". Or /relay to start over.`
  )
}

/** After a restart lost the run, relay saved the resumed save turn's note; what's left to do. */
export function resumedNoteNotice(notePath: string): string {
  return (
    `saved the resumed turn's handoff note to ${notePath}, but nothing was compacted, since a restart lost the run. ` +
    `To finish: /compact, then send "Continue from @${notePath}". Or /relay to start over.`
  )
}

/** Longest stretch of the note quoted into the fork prompt. */
const NOTE_LIMIT = 8000

/**
 * The fork replays the main thread's last request, which ends before the save
 * turn's final message (the handoff note), so the note rides along.
 */
export function continuationPrompt(note: string, notePath: string): string {
  const trimmed = note.trim()
  const quoted = trimmed.length > NOTE_LIMIT ? `${trimmed.slice(0, NOTE_LIMIT)}\n[…]` : trimmed
  return (
    `The checkpoint turn's final message is the handoff note, saved to ${notePath}:\n\n` +
    `<handoff-note path="${notePath}">\n${quoted}\n</handoff-note>\n\n` +
    `List @${notePath} first among the files to read.\n\n${CONTINUATION_PROMPT}`
  )
}

/** Drops one code fence wrapping the whole reply, and surrounding whitespace. */
export function cleanContinuation(text: string): string {
  const trimmed = text.trim()
  const fenced = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1$/.exec(trimmed)
  if (!fenced) return trimmed
  const [, fence = '', inner = ''] = fenced
  // A line opening the same fence inside means several blocks, not one wrapper.
  const opensAgain = inner.split('\n').some(line => line.trimStart().startsWith(fence))
  return opensAgain ? trimmed : inner.trim()
}

/** Where the generated continuation prompt is kept: beside its note, so it can be compared with what was sent. */
export function promptPathFor(notePath: string): string {
  return /\.md$/.test(notePath) ? notePath.replace(/\.md$/, '.prompt.md') : `${notePath}.prompt.md`
}

/**
 * Deliveries that start a turn on their own: background tasks, other
 * sessions, schedules. Held from the save turn's start until the person's
 * next prompt's turn starts, so none runs between the checkpoint and the
 * continuation prompt. Not `channel`: that may be the person driving the
 * session remotely, who couldn't end a hold from there.
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

/** The hold with `text` added, or null when it isn't holding (a release won the race), so the delivery passes. */
export function holdAppend(cur: Hold, text: string): Hold | null {
  return cur.isHolding ? { ...cur, items: [...cur.items, text] } : null
}

/**
 * The hold after a prompt that took `taken` (when the hold was at `gen`) was
 * refused further down, or null when the hold has been released or restarted
 * since and must not be revived. A prompt that ended the hold gives it back,
 * items first; one that took nothing leaves another prompt's handoff alone.
 */
export function restoreHold(cur: Hold, taken: readonly string[], gen: number, didEnd: boolean): Hold | null {
  if ((cur.gen ?? 0) !== gen) return null
  if (!didEnd) return cur
  return { ...cur, isHolding: true, endsAtTurn: false, items: [...taken, ...cur.items] }
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
  return `Read every file below whose path is prefixed with @ before doing anything else (they are not attached automatically), then continue.\n\n${text}`
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
