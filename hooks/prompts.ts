import type { Command } from '../types'

/** Leads the save prompt, so the save turn can be told apart by its text. */
export const SAVE_MARKER = '[handoff] Checkpoint before compaction.'

/**
 * Where the handoff note goes: `dir` (default: the system temp directory's
 * claude-handoff/), named for the project and the UTC time the run started.
 */
export function notePathFor(dir: string, projectRoot: string, nowMs: number): string {
  const project = (projectRoot.replace(/\/+$/, '').split('/').pop() || 'session').replace(/[^A-Za-z0-9._-]/g, '-')
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${dir.replace(/\/+$/, '')}/${project}-${stamp}.md`
}

/** The save turn's prompt: update stale docs, then end with the handoff note, which the plugin saves. */
export function savePrompt(focus: string, notePath: string): string {
  const lines = [
    `${SAVE_MARKER} The conversation will be compacted after this turn, and the next session starts from what you leave now.`,
    '',
    "1. Update the project's docs and notes that this session's work made stale, in place, following CLAUDE.md / AGENTS.md. Don't create a handoff note in the project.",
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
  'Point to the files the next agent should read immediately, each path prefixed with `@`. ' +
  "Add anything else they need to know that those files don't say, without repeating what they do. " +
  'Output only the prompt: no preamble, no wrapper formatting, no code fence.'

/** The note inside the save turn's <handoff-note> tags, or the whole message when it has none. */
export function extractNote(answer: string): string {
  const tagged = /<handoff-note>([\s\S]*?)<\/handoff-note>/.exec(answer)
  return (tagged ? (tagged[1] ?? '') : answer).trim()
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
