import type { Command } from '../types'

/** Leads the save prompt, so the save turn can be told apart by its text. */
export const SAVE_MARKER = '[handoff] Checkpoint before compaction.'

/** The save turn's prompt: write the session's state somewhere durable. */
export function savePrompt(focus: string): string {
  const lines = [
    `${SAVE_MARKER} The conversation will be compacted after this turn, and the next session starts from what you write now.`,
    '',
    "1. Save the current working state to durable locations. Use the places this project already keeps it (handoff notes, project hubs, session logs, plans, tickets), following CLAUDE.md / AGENTS.md. If it has none, write a handoff note where the project keeps notes, or HANDOFF.md at the project root.",
    '2. Update docs and notes that what was done this session made stale.',
    '3. Record what is done; what is in progress, exactly where it stands (branches, uncommitted changes, running jobs, open PRs); decisions and why; what you learned; issues, gotchas and workarounds; and next steps, each with a disposition (do / skip / defer).',
    "4. Link to what's already durable instead of repeating it.",
    '5. Finish with the list of files you wrote or updated.',
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

/** Longest save-turn answer quoted into the fork prompt. */
const ANSWER_LIMIT = 8000

/**
 * The fork replays the main thread's last request, which ends before the save
 * turn's final answer (often the list of files written), so it rides along.
 */
export function continuationPrompt(answer: string): string {
  const trimmed = answer.trim()
  if (!trimmed) return CONTINUATION_PROMPT
  const quoted = trimmed.length > ANSWER_LIMIT ? `${trimmed.slice(0, ANSWER_LIMIT)}\n[…]` : trimmed
  return `The checkpoint turn ended with this reply:\n\n<checkpoint-reply>\n${quoted}\n</checkpoint-reply>\n\n${CONTINUATION_PROMPT}`
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
