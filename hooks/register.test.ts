import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionCompactResult } from 'claude-code'

import { CONTINUATION_PROMPT, SAVE_MARKER } from './prompts'

const T0 = Date.UTC(2026, 9, 7, 15, 0)
const SEC = 1000
const CONTINUATION = '@notes/hub.md\n@notes/log.md\nResume at step 3; the staging deploy is still running.'

type WorldOpts = {
  turns?: number
  forkText?: string | null
  /** How many compaction attempts throw (as a running turn makes them) before one succeeds. */
  compactFailures?: number
  compactSkip?: string
  store?: Record<string, unknown>
}

/** The engine beneath the plugin, recording what the plugin asked of it, in order. */
const world = (on: On, opts: WorldOpts = {}) => {
  const clock = mock.clock(on, { now: T0 })
  mock.store(on, opts.store ?? {})
  const calls: string[] = []
  const submits: { text: string; asUser?: boolean }[] = []
  const forks: string[] = []
  const compacts: (string | undefined)[] = []
  const fills: string[] = []
  const copies: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  let compactFailures = opts.compactFailures ?? 0

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.turns', () => ({ value: opts.turns ?? 5 }))
  on('prompt.submit', ($, e) => {
    calls.push('submit')
    submits.push({ text: e.text, asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined })
    return { text: e.text, origin: e.origin }
  })
  on('model.fork', ($, e) => {
    calls.push('fork')
    forks.push(e.prompt)
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (opts.forkText === null) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage } }
    return { value: { isAnswered: true as const, text: opts.forkText ?? CONTINUATION, usage } }
  })
  on('session.compact', ($, e): SessionCompactResult => {
    calls.push('compact')
    compacts.push(e.instructions)
    if (compactFailures > 0) {
      compactFailures--
      throw new Error('a turn is running')
    }
    if (opts.compactSkip) return { skip: opts.compactSkip }
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  })
  on('prompt.fill', ($, e) => {
    calls.push('fill')
    fills.push(e.text)
    return { isFilled: true }
  })
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true as const } }
  })
  on('ui.log', ($, e) => {
    logs.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))

  return { clock, calls, submits, forks, compacts, fills, copies, logs, toasts }
}

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const start = async ($: any) => {
  await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
}

const handoff = ($: any, args = '') => $.command.run({ command: 'handoff', args, ...COMMAND })

/** Runs the save turn the plugin submitted, ending it with `reason`. */
const saveTurn = async ($: any, w: ReturnType<typeof world>, reason: 'answer' | 'aborted' = 'answer') => {
  const text = w.submits.at(-1)?.text ?? ''
  await $.turn.start({ text, turnId: 'save-1' })
  await $.turn.complete({
    answer: 'Saved to notes/hub.md and notes/log.md.',
    durationMs: 30 * SEC,
    isAborted: reason === 'aborted',
    turnId: 'save-1',
    reason,
  })
}

describe('handoff', () => {
  test('saves, forks the continuation, compacts, then fills the prompt box', async ($, on) => {
    const w = world(on)
    await start($)

    const r = await handoff($, 'stress the rollback plan')
    expect(r.text).toMatch(/saving/i)
    await w.clock.advance(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.text.startsWith(SAVE_MARKER)).toBe(true)
    expect(w.submits[0]?.text).toContain('stress the rollback plan')
    expect(w.submits[0]?.asUser).toBe(true)

    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
    expect(w.forks).toEqual([CONTINUATION_PROMPT])
    expect(w.compacts).toEqual(["Keep any information that's helpful to the agent and not written to a durable location."])
    expect(w.fills).toEqual([CONTINUATION])
    expect(w.copies).toEqual([CONTINUATION])

    const status = await handoff($, 'status')
    expect(status.text).toMatch(/idle/i)
  })

  test('a turn that is not the save turn does not continue the handoff', async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)

    await $.turn.start({ text: 'something else', turnId: 'other' })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'other', reason: 'answer' })
    await w.clock.advance(5 * SEC)
    expect(w.forks.length).toBe(0)

    await saveTurn($, w)
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
  })

  test('a subagent turn never continues the handoff', async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await $.turn.start({ text: w.submits[0]?.text ?? '', turnId: 'save-1' })
    await $.turn.complete({
      answer: 'sub',
      durationMs: 1,
      isAborted: false,
      turnId: 'save-1',
      reason: 'answer',
      agentId: 'agent-1',
    })
    await w.clock.advance(5 * SEC)
    expect(w.forks.length).toBe(0)
  })

  test('an interrupted save turn stops the handoff before anything is compacted', async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w, 'aborted')
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit'])
    expect(w.logs.some(l => /stopped/i.test(l))).toBe(true)
    expect((await handoff($, 'status')).text).toMatch(/idle/i)
  })

  test('a failed fork stops before compacting', async ($, on) => {
    const w = world(on, { forkText: null })
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit', 'fork'])
    expect(w.logs.some(l => /empty-reply/.test(l))).toBe(true)
  })

  test('retries compaction while a turn is still running', async ($, on) => {
    const w = world(on, { compactFailures: 2 })
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(10 * SEC)

    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'compact', 'compact', 'fill'])
  })

  test('gives up on compaction after its retries, keeps the prompt and fills nothing', async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * 60 * SEC)

    expect(w.fills.length).toBe(0)
    expect(w.logs.some(l => /\/handoff paste/.test(l))).toBe(true)
    expect((await handoff($, 'status')).text).toMatch(/idle/i)

    await handoff($, 'paste')
    expect(w.fills).toEqual([CONTINUATION])
  })

  test('a skipped compaction fills nothing and says why', async ($, on) => {
    const w = world(on, { compactSkip: 'blocked by a PreCompact hook' })
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.fills.length).toBe(0)
    expect(w.logs.some(l => l.includes('blocked by a PreCompact hook'))).toBe(true)
  })

  test('submit mode sends the prompt and tells the model to read the files', { options: { deliver: 'submit' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.fills.length).toBe(0)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.text).toContain(CONTINUATION)
    expect(w.submits[1]?.text).toMatch(/read/i)
    expect(w.submits[1]?.asUser).toBe(true)
  })

  test('custom compaction instructions and no clipboard', { options: { compactInstructions: 'Keep the plan.', copyToClipboard: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.compacts).toEqual(['Keep the plan.'])
    expect(w.copies.length).toBe(0)
  })

  test('refuses a second run while one is in progress', async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)
    const again = await handoff($)
    expect(again.text).toMatch(/already/i)
    expect(w.submits.length).toBe(1)
  })

  test('cancel during the save turn stops the continuation', async ($, on) => {
    const w = world(on)
    await start($)
    await handoff($)
    await w.clock.advance(0)
    const c = await handoff($, 'cancel')
    expect(c.text).toMatch(/cancel/i)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)
    expect(w.forks.length).toBe(0)
  })

  test('refuses to start in an empty conversation', async ($, on) => {
    const w = world(on, { turns: 0 })
    await start($)
    const r = await handoff($)
    expect(r.text).toMatch(/nothing/i)
    expect(w.submits.length).toBe(0)
  })

  test('paste refills the last saved prompt, even from another session', async ($, on) => {
    const w = world(on, { store: { lastPrompt: { text: 'from before', at: T0 - 3600 * SEC, sessionId: 'old' } } })
    await start($)
    const r = await handoff($, 'paste')
    expect(w.fills).toEqual(['from before'])
    expect(r.text).toMatch(/old/)
  })

  test('paste with nothing saved says so', async ($, on) => {
    const w = world(on)
    await start($)
    const r = await handoff($, 'paste')
    expect(w.fills.length).toBe(0)
    expect(r.text).toMatch(/no /i)
  })
})
