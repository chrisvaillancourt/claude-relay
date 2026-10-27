import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionCompactResult } from 'claude-code'

import { continuationPrompt, SAVE_MARKER } from './prompts'

// The test environment has timers at run time; lib es2023 doesn't declare them.
declare const setTimeout: (fn: () => void, ms: number) => unknown

const T0 = Date.UTC(2026, 9, 7, 15, 0)
const SEC = 1000
const CONTINUATION = '@notes/hub.md\n@notes/log.md\nResume at step 3; the staging deploy is still running.'
const SAVE_ANSWER = '# Handoff\n\nStep 2 of 3 done; notes/hub.md is current.'
/** The note as relay saves it: the session id added, so the next session can find this one. */
const NOTED = `${SAVE_ANSWER}\n\nSession: sid-1`
/** Where the note lands for T0, a TMPDIR of /tmp/T/ and a project root of /work/my-proj. */
const NOTE = '/tmp/T/claude-relay/my-proj-20261007T150000Z.md'

function deferred<T>() {
  let resolve!: (v: T) => void
  const p = new Promise<T>(r => {
    resolve = r
  })
  return { p, resolve }
}

type WorldOpts = {
  turns?: number
  forkText?: string | null
  /** How many compaction attempts throw (as a running turn makes them) before one succeeds. */
  compactFailures?: number
  compactSkip?: string
  /** Holds the fork (or the first compaction) open until the test resolves it. */
  forkGate?: Promise<void>
  compactGate?: Promise<void>
  draft?: string
  fillOk?: boolean
  dropSubmit?: (text: string) => string | undefined
  /** Makes the submit reject (the kit skips a throwing mock and rejects with its fallback error). */
  throwSubmit?: (text: string) => boolean
  store?: Record<string, unknown>
  /** TMPDIR as the environment has it; null for unset. */
  tmpdir?: string | null
  writeFails?: boolean
  answer?: string
}

/** The engine beneath the plugin, recording what the plugin asked of it, in order. */
const world = (on: On, opts: WorldOpts = {}) => {
  const clock = mock.clock(on, { now: T0 })
  // The store as a map the test can read back (the kit's mock.store keeps its own).
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', ($, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, opts.tmpdir === null ? {} : { TMPDIR: opts.tmpdir ?? '/tmp/T/' })
  const writes: { path: string; text: string }[] = []
  on('fs.write', ($, e) => {
    if (opts.writeFails) return { deny: 'read-only file system' }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.root', () => ({ value: '/work/my-proj' }))
  const calls: string[] = []
  const submits: { text: string; asUser?: boolean; origin: string; context?: readonly string[] }[] = []
  /** What the prompt box holds: the person's draft, then whatever the plugin filled. */
  const box = { text: opts.draft ?? '' }
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
    submits.push({
      text: e.text,
      asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined,
      origin: e.origin.kind,
      context: e.context,
    })
    if (opts.throwSubmit?.(e.text)) throw new Error('submit failed')
    const drop = opts.dropSubmit?.(e.text)
    if (drop !== undefined) return { drop }
    return { text: e.text, origin: e.origin }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: 0 } }))
  on('model.fork', async ($, e) => {
    calls.push('fork')
    forks.push(e.prompt)
    if (opts.forkGate) await opts.forkGate
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    if (opts.forkText === null) return { value: { isAnswered: false as const, reason: 'empty-reply' as const, usage } }
    return { value: { isAnswered: true as const, text: opts.forkText ?? CONTINUATION, usage } }
  })
  let compactGate = opts.compactGate
  on('session.compact', async ($, e): Promise<SessionCompactResult> => {
    calls.push('compact')
    compacts.push(e.instructions)
    if (compactGate) {
      const gate = compactGate
      compactGate = undefined
      await gate
    }
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
    const isFilled = opts.fillOk ?? true
    if (isFilled) box.text = e.text
    return { isFilled }
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

  return { clock, calls, submits, forks, compacts, fills, copies, logs, toasts, writes, box, store, answer: opts.answer ?? SAVE_ANSWER }
}

/** A prompt the engine queued from somewhere other than the plugin: a background task, or the person's Enter. */
const arrive = ($: any, text: string, kind: 'task-notification' | 'peer' | 'composer', turnId?: string) =>
  $.prompt.submit({ text, origin: { kind }, wait: false, ...(turnId ? { turnId } : {}) })

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const start = async ($: any, isInteractive = true) => {
  await $.session.start({ cwd: '/x', surface: isInteractive ? 'terminal' : null, isInteractive })
}

const relay = ($: any, args = '') => $.command.run({ command: 'relay', args, ...COMMAND })

/** Runs the save turn the plugin submitted, ending it with `reason`. */
const saveTurn = async ($: any, w: ReturnType<typeof world>, reason: 'answer' | 'aborted' = 'answer') => {
  const text = w.submits.at(-1)?.text ?? ''
  await $.turn.start({ text, turnId: 'save-1' })
  await $.turn.complete({
    answer: w.answer,
    durationMs: 30 * SEC,
    isAborted: reason === 'aborted',
    turnId: 'save-1',
    reason,
  })
}

describe('relay', () => {
  test('saves, forks the continuation, compacts, then fills the prompt box', async ($, on) => {
    const w = world(on)
    await start($)

    const r = await relay($, 'stress the rollback plan')
    expect(r.text).toMatch(/saving/i)
    await w.clock.advance(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.text.startsWith(SAVE_MARKER)).toBe(true)
    expect(w.submits[0]?.text).toContain('stress the rollback plan')
    expect(w.submits[0]?.asUser).toBe(true)

    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
    expect(w.submits[0]?.text).toContain(NOTE)
    expect(w.writes[0]).toEqual({ path: NOTE, text: `${NOTED}\n` })
    expect(w.forks).toEqual([continuationPrompt(NOTED, NOTE)])
    expect(w.forks[0]).toContain(`@${NOTE}`)
    expect(w.compacts).toEqual(["Keep any information that's helpful to the agent and not written to a durable location."])
    expect(w.fills).toEqual([CONTINUATION])
    expect(w.copies).toEqual([CONTINUATION])

    const status = await relay($, 'status')
    expect(status.text).toMatch(/idle/i)
  })

  test('a turn that is not the save turn does not continue the run', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)

    await $.turn.start({ text: 'something else', turnId: 'other' })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'other', reason: 'answer' })
    await w.clock.advance(SEC)
    expect(w.forks.length).toBe(0)

    await saveTurn($, w)
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
  })

  test('a subagent turn never continues the run', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
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

  test('an interrupted save turn stops the run before anything is compacted', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w, 'aborted')
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit'])
    expect(w.logs.some(l => /stopped/i.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('a failed fork stops before compacting', async ($, on) => {
    const w = world(on, { forkText: null })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit', 'fork'])
    expect(w.logs.some(l => /empty-reply/.test(l))).toBe(true)
  })

  test('retries compaction while a turn is still running', async ($, on) => {
    const w = world(on, { compactFailures: 2 })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(10 * SEC)

    // the box is filled once, as the first attempt starts
    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill', 'compact', 'compact'])
    expect(w.toasts.some(t => /review the prompt/.test(t))).toBe(true)
  })

  test('gives up on compaction after its retries, and warns about the prompt already in the box', async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * 60 * SEC)

    expect(w.compacts.length).toBe(3)
    expect(w.fills).toEqual([CONTINUATION])
    expect(w.logs.some(l => /couldn't compact/.test(l) && /prompt box/.test(l) && /\/compact/.test(l))).toBe(true)
  })

  test('gives up on compaction after its retries, keeps the prompt and fills nothing', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * 60 * SEC)

    // a rejection that outlasts the save turn's teardown is not retried for long
    expect(w.compacts.length).toBe(3)
    expect(w.fills.length).toBe(0)
    expect(w.logs.some(l => /\/relay paste/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)

    await relay($, 'paste')
    expect(w.fills).toEqual([CONTINUATION])
  })

  test('a skipped compaction fills nothing and says why', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { compactSkip: 'blocked by a PreCompact hook' })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.fills.length).toBe(0)
    expect(w.logs.some(l => l.includes('blocked by a PreCompact hook'))).toBe(true)
  })

  test('submit mode sends the prompt and tells the model to read the files', { options: { deliver: 'submit' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
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
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.compacts).toEqual(['Keep the plan.'])
    expect(w.copies.length).toBe(0)
  })

  test('custom save instructions reach the save prompt', { options: { saveInstructions: '  Follow the closeout skill.  ' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)

    expect(w.submits[0]?.text.startsWith(SAVE_MARKER)).toBe(true)
    expect(w.submits[0]?.text).toContain('1. Follow the closeout skill.\n')
    expect(w.submits[0]?.text).not.toContain("Update the project's docs")
  })

  test('refuses a second run while one is in progress', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    const again = await relay($)
    expect(again.text).toMatch(/already/i)
    expect(w.submits.length).toBe(1)
  })

  test('cancel during the save turn stops the continuation', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    const c = await relay($, 'cancel')
    expect(c.text).toMatch(/cancel/i)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)
    expect(w.forks.length).toBe(0)
  })

  test('refuses to start in an empty conversation', async ($, on) => {
    const w = world(on, { turns: 0 })
    await start($)
    const r = await relay($)
    expect(r.text).toMatch(/nothing/i)
    expect(w.submits.length).toBe(0)
  })

  test('paste refills the last saved prompt, even from another session', async ($, on) => {
    const w = world(on, { store: { lastPrompt: { text: 'from before', at: T0 - 3600 * SEC, sessionId: 'old' } } })
    await start($)
    const r = await relay($, 'paste')
    expect(w.fills).toEqual(['from before'])
    expect(r.text).toMatch(/old/)
  })

  test('paste with nothing saved says so', async ($, on) => {
    const w = world(on)
    await start($)
    const r = await relay($, 'paste')
    expect(w.fills.length).toBe(0)
    expect(r.text).toMatch(/no /i)
  })
  test('headless: a compaction rejection is not retried', async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($, false)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(60 * SEC)

    expect(w.compacts.length).toBe(1)
    expect(w.logs.some(l => /couldn't compact/.test(l))).toBe(true)
  })

  test('a turn that starts after the save turn stops the run before compacting', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await $.turn.start({ text: 'a prompt the person queued', turnId: 'next' })
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit', 'fork'])
    expect(w.logs.some(l => /new turn started/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('cancel during the fork keeps the previous saved prompt and the clipboard', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { forkGate: gate.p, store: { lastPrompt: { text: 'good one', at: T0, sessionId: 'sid-1' } } })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    expect(w.calls).toEqual(['submit', 'fork'])

    await relay($, 'cancel')
    gate.resolve()
    await w.clock.advance(5 * SEC)

    expect(w.copies.length).toBe(0)
    expect(w.calls).toEqual(['submit', 'fork'])
    await relay($, 'paste')
    expect(w.fills).toEqual(['good one'])
  })

  test("a cancelled run's late compaction rejection can't cancel the next run's timer", async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p, compactFailures: 1 })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    // the box is filled as compaction starts
    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])

    await relay($, 'cancel')
    await relay($, 'second run')
    gate.resolve()
    await new Promise<void>(r => setTimeout(() => r(), 10))
    await relay($, 'cancel')
    await w.clock.advance(10 * SEC)

    // the second cancel stopped the second run's save prompt; the stale run retried nothing
    expect(w.submits.length).toBe(1)
    expect(w.compacts.length).toBe(1)
  })

  test('a reload during the save turn keeps the run', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await $.turn.start({ text: w.submits[0]?.text ?? '', turnId: 'save-1' })
    await start($) // a hot reload fires session.start again
    await $.turn.complete({ answer: SAVE_ANSWER, durationMs: 1, isAborted: false, turnId: 'save-1', reason: 'answer' })
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
  })

  test('a reload after the save turn resets the run and points to paste', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    await start($)

    expect((await relay($, 'status')).text).toMatch(/idle/i)
    expect(w.logs.some(l => /reload/.test(l) && /\/relay paste/.test(l))).toBe(true)
  })

  test('a save turn the marker never matched times out instead of hanging', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await $.turn.start({ text: 'rewritten by another plugin', turnId: 'save-1' })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'save-1', reason: 'answer' })
    await w.clock.advance(10 * SEC)

    expect(w.forks.length).toBe(0)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
    expect(w.logs.some(l => /couldn't find the save turn/.test(l))).toBe(true)
  })

  test('a dropped save prompt stops the run', async ($, on) => {
    const w = world(on, { dropSubmit: t => (t.startsWith(SAVE_MARKER) ? 'blocked' : undefined) })
    await start($)
    await relay($)
    await w.clock.advance(0)

    expect((await relay($, 'status')).text).toMatch(/idle/i)
    expect(w.logs.some(l => /dropped \(blocked\)/.test(l))).toBe(true)
  })

  test('filling keeps a draft the person typed, after the continuation prompt', async ($, on) => {
    const w = world(on, { draft: 'also check the logs' })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.fills).toEqual([`${CONTINUATION}\n\nalso check the logs`])
  })

  test('a box that refuses the fill gets the prompt in the transcript', async ($, on) => {
    const w = world(on, { fillOk: false })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.logs.some(l => l.includes(CONTINUATION))).toBe(true)
  })

  test('submit mode: a dropped continuation prompt is reported', { options: { deliver: 'submit' } }, async ($, on) => {
    const w = world(on, { dropSubmit: t => (t.startsWith(SAVE_MARKER) ? undefined : 'blocked') })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.submits.length).toBe(2)
    expect(w.logs.some(l => /continuation prompt was dropped/.test(l))).toBe(true)
  })

  test('a fork reply that is only an empty fence stops before compacting', async ($, on) => {
    const w = world(on, { forkText: '```\n```' })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'fork'])
    expect(w.logs.some(l => /empty/.test(l))).toBe(true)
  })
  test('an empty final message saves nothing and stops before forking', async ($, on) => {
    const w = world(on, { answer: '   ' })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.writes.length).toBe(0)
    expect(w.calls).toEqual(['submit'])
    expect(w.logs.some(l => /no handoff note/.test(l))).toBe(true)
  })

  test('a note that cannot be written stops before forking', async ($, on) => {
    const w = world(on, { writeFails: true })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit'])
    expect(w.logs.some(l => /read-only file system/.test(l))).toBe(true)
  })

  test('with no TMPDIR the note goes under /tmp', async ($, on) => {
    const w = world(on, { tmpdir: null })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.writes[0]?.path).toBe('/tmp/claude-relay/my-proj-20261007T150000Z.md')
  })

  test('noteDir overrides the temp directory', { options: { noteDir: '/scratch/handoffs/' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    expect(w.submits[0]?.text).toContain('/scratch/handoffs/my-proj-20261007T150000Z.md')
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.writes[0]?.path).toBe('/scratch/handoffs/my-proj-20261007T150000Z.md')
  })
  test('only the tagged note is saved', async ($, on) => {
    const w = world(on, { answer: 'Nothing was stale.\n\n<handoff-note>\n# Handoff\nStep 2.\n</handoff-note>' })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.writes[0]).toEqual({ path: NOTE, text: '# Handoff\nStep 2.\n\nSession: sid-1\n' })
    expect(w.forks[0]).not.toContain('Nothing was stale')
  })
})

describe('the continuation prompt arrives while compaction runs', () => {
  test('the box is filled before compaction finishes, and the toast follows it', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
    expect(w.fills).toEqual([CONTINUATION])
    expect(w.toasts.length).toBe(0)
    expect((await relay($, 'status')).text).toMatch(/continuing/i)

    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.fills.length).toBe(1)
    expect(w.toasts.some(t => /review the prompt/.test(t))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('a prompt the person already sent gets a plain toast after compaction', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    w.box.text = '' // Enter queued it
    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.toasts.some(t => /review the prompt/.test(t))).toBe(false)
    expect(w.toasts.some(t => /compacted/.test(t))).toBe(true)
  })

  test('a skipped compaction says the prompt in the box should wait for /compact', async ($, on) => {
    const w = world(on, { compactSkip: 'blocked by a PreCompact hook' })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(5 * SEC)

    expect(w.fills).toEqual([CONTINUATION])
    expect(w.logs.some(l => l.includes('blocked by a PreCompact hook') && /prompt box/.test(l))).toBe(true)
  })

  test('with fillDuringCompaction off, the box is filled only after compaction', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    expect(w.fills.length).toBe(0)

    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.fills).toEqual([CONTINUATION])
  })

  test('the generated prompt is kept beside the note, to compare with what was sent', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect(w.writes).toEqual([
      { path: NOTE, text: `${NOTED}\n` },
      { path: NOTE.replace(/\.md$/, '.prompt.md'), text: `${CONTINUATION}\n` },
    ])
  })
})

describe('background notifications wait for the continuation prompt', () => {
  test('a notification after the save turn is held, then rides along with the person’s prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)

    const held = await arrive($, '<task-notification>shell b1 finished</task-notification>', 'task-notification')
    expect(held.drop).toMatch(/relay/i)
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])

    const sent = await arrive($, CONTINUATION, 'composer')
    expect(sent.drop).toBeUndefined()
    const last = w.submits.at(-1)
    expect(last?.origin).toBe('composer')
    expect(last?.context?.some(c => c.includes('shell b1 finished'))).toBe(true)

    // the hold ends when that prompt's turn starts
    await $.turn.start({ text: CONTINUATION, turnId: 'next' })
    const later = await arrive($, '<task-notification>agent a2 finished</task-notification>', 'task-notification')
    expect(later.drop).toBeUndefined()
  })

  test('a notification delivered into a running turn passes through', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)

    const r = await arrive($, '<task-notification>x</task-notification>', 'task-notification', 'turn-9')
    expect(r.drop).toBeUndefined()
  })

  test('no run, no hold', async ($, on) => {
    world(on)
    await start($)
    const r = await arrive($, '<task-notification>x</task-notification>', 'task-notification')
    expect(r.drop).toBeUndefined()
  })

  test('a message from another session is held too', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)

    const r = await arrive($, 'Another Claude session sent a message: done', 'peer')
    expect(r.drop).toMatch(/relay/i)
  })

  test('cancel releases what was held', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { forkGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    await arrive($, '<task-notification>shell b1 finished</task-notification>', 'task-notification')

    await relay($, 'cancel')
    await w.clock.advance(SEC)
    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('shell b1 finished'))).toBe(true)
    gate.resolve()
  })

  test('the hold starts with the save turn, so a delivery dequeued as it ends is caught', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await $.turn.start({ text: w.submits[0]?.text ?? '', turnId: 'save-1' })

    // dequeued while idle (no turnId) before turn.complete's hooks ran
    const r = await arrive($, '<task-notification>early</task-notification>', 'task-notification')
    expect(r.drop).toMatch(/relay/i)
    // one delivered into the save turn passes
    expect((await arrive($, '<task-notification>into</task-notification>', 'task-notification', 'save-1')).drop).toBeUndefined()
  })

  test('a save turn that fails releases what was held', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await $.turn.start({ text: w.submits[0]?.text ?? '', turnId: 'save-1' })
    await arrive($, '<task-notification>early</task-notification>', 'task-notification')
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'save-1', reason: 'aborted' })
    await w.clock.advance(SEC)

    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('early'))).toBe(true)
    expect((await arrive($, '<task-notification>later</task-notification>', 'task-notification')).drop).toBeUndefined()
  })

  test('a failed fork releases what was held, since no prompt is coming', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { forkText: null, forkGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await arrive($, '<task-notification>early</task-notification>', 'task-notification')
    gate.resolve()
    await w.clock.advance(SEC)

    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('early'))).toBe(true)
  })

  test('a person’s prompt refused further down keeps what was held', async ($, on) => {
    const w = world(on, { dropSubmit: t => (t === 'refused' ? 'blocked' : undefined) })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>b1</task-notification>', 'task-notification')

    expect((await arrive($, 'refused', 'composer')).drop).toBe('blocked')
    await arrive($, CONTINUATION, 'composer')
    expect(w.submits.at(-1)?.context?.some(c => c.includes('b1'))).toBe(true)
  })

  test('the hold lasts until the person’s turn starts; what arrives in between follows that turn', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, CONTINUATION, 'composer')

    // queued before the person's prompt in the engine, dequeued after Enter
    expect((await arrive($, '<task-notification>b2</task-notification>', 'task-notification')).drop).toMatch(/relay/i)
    await $.turn.start({ text: CONTINUATION, turnId: 'next' })
    await w.clock.advance(SEC)
    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('b2'))).toBe(true)
    expect((await arrive($, '<task-notification>b3</task-notification>', 'task-notification')).drop).toBeUndefined()
  })

  test('a plugin’s prompt neither is held nor ends the hold', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>b1</task-notification>', 'task-notification')

    await $.prompt.submit({ text: 'from another plugin', origin: { kind: 'plugin', name: 'other' }, wait: false })
    expect(w.submits.at(-1)?.context).toBeUndefined()
    expect((await arrive($, '<task-notification>b2</task-notification>', 'task-notification')).drop).toMatch(/relay/i)
    // the person's prompt still gets both
    await arrive($, CONTINUATION, 'composer')
    const ctx = w.submits.at(-1)?.context?.join('\n') ?? ''
    expect(ctx).toContain('b1')
    expect(ctx).toContain('b2')
  })

  test('cancel after a finished run releases the hold, and status shows it', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>b1</task-notification>', 'task-notification')

    expect((await relay($, 'status')).text).toMatch(/holding 1/i)
    const c = await relay($, 'cancel')
    expect(c.text).not.toMatch(/nothing to cancel/i)
    await w.clock.advance(SEC)
    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('b1'))).toBe(true)
  })

  test('a new /relay carries what is still held into its save prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>b1</task-notification>', 'task-notification')

    await relay($, 'again')
    await w.clock.advance(0)
    const save = w.submits.at(-1)?.text ?? ''
    expect(save.startsWith(SAVE_MARKER)).toBe(true)
    expect(save).toContain('b1')
  })

  test('a prompt sent in the compaction retry window is reported as run uncompacted', async ($, on) => {
    const w = world(on, { compactFailures: 1 })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    await $.turn.start({ text: CONTINUATION, turnId: 'next' })
    await w.clock.advance(5 * SEC)

    expect(w.logs.some(l => /uncompacted/.test(l))).toBe(true)
  })

  test('held messages handed back and refused further down go to the transcript', async ($, on) => {
    const w = world(on, { dropSubmit: t => (t.startsWith('relay held') ? 'blocked' : undefined) })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, CONTINUATION, 'composer')
    await arrive($, '<task-notification>late-b2</task-notification>', 'task-notification')
    await $.turn.start({ text: CONTINUATION, turnId: 'next' })
    await w.clock.advance(SEC)

    expect(w.logs.some(l => l.includes('late-b2') && /blocked/.test(l))).toBe(true)
  })

  test('a refused replacement save puts what it carried in the transcript', async ($, on) => {
    const w = world(on, { dropSubmit: t => (t.startsWith(SAVE_MARKER) && t.includes('prev-b1') ? 'blocked' : undefined) })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>prev-b1</task-notification>', 'task-notification')

    await relay($, 'again')
    await w.clock.advance(SEC)
    expect(w.logs.some(l => l.includes('prev-b1'))).toBe(true)
  })

  test('a second prompt refused after the first was queued leaves the first one’s handoff alone', async ($, on) => {
    const w = world(on, { dropSubmit: t => (t === 'refused B' ? 'blocked' : undefined) })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, CONTINUATION, 'composer')
    await arrive($, '<task-notification>b2</task-notification>', 'task-notification')
    expect((await arrive($, 'refused B', 'composer')).drop).toBe('blocked')

    await $.turn.start({ text: CONTINUATION, turnId: 'next' })
    await w.clock.advance(SEC)
    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('b2'))).toBe(true)
    expect((await relay($, 'status')).text).not.toMatch(/holding/i)
  })

  test('a prompt typed into the save turn does not end the hold', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await $.turn.start({ text: w.submits[0]?.text ?? '', turnId: 'save-1' })
    await arrive($, '<task-notification>b1</task-notification>', 'task-notification')
    await arrive($, 'typed during the save', 'composer', 'save-1')
    expect(w.submits.at(-1)?.context).toBeUndefined()
    await $.turn.complete({ answer: w.answer, durationMs: 1, isAborted: false, turnId: 'save-1', reason: 'answer' })
    await w.clock.advance(SEC)

    await arrive($, CONTINUATION, 'composer')
    expect(w.submits.at(-1)?.context?.some(c => c.includes('b1'))).toBe(true)
  })

  test('a fill that fails at delivery keeps holding, since the prompt is still to be sent', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { fillOk: false })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)

    expect((await arrive($, '<task-notification>b1</task-notification>', 'task-notification')).drop).toMatch(/relay/i)
    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('b1'))).toBe(false)
  })

  test('a turn that starts and ends inside the retry window still stops the run', async ($, on) => {
    const w = world(on, { compactFailures: 1 })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    await $.turn.start({ text: CONTINUATION, turnId: 'next' })
    await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 'next', reason: 'answer' })
    await w.clock.advance(5 * SEC)

    expect(w.compacts.length).toBe(1)
    expect(w.logs.some(l => /uncompacted/.test(l))).toBe(true)
  })

  test('submit mode: a continuation submit that fails logs what it carried', { options: { deliver: 'submit' } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p, throwSubmit: t => t.includes(CONTINUATION) })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>sm-b1</task-notification>', 'task-notification')

    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.logs.some(l => /couldn't submit the continuation prompt/.test(l))).toBe(true)
    expect(w.logs.some(l => l.includes('sm-b1'))).toBe(true)
  })

  test('cancelling a new /relay before its save prompt goes out releases what it would have carried', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>rc-b1</task-notification>', 'task-notification')

    await relay($, 'again')
    await relay($, 'cancel') // before the save prompt's timer runs
    await w.clock.advance(SEC)
    const carried = w.submits.some(s => s.text.includes('rc-b1'))
    const logged = w.logs.some(l => l.includes('rc-b1'))
    expect(carried || logged).toBe(true)
  })

  test('submit mode: the held notifications ride along with the continuation prompt', { options: { deliver: 'submit' } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>shell b1 finished</task-notification>', 'task-notification')

    gate.resolve()
    await w.clock.advance(SEC)
    // a plugin's submit can't carry context, so the notifications go in its text
    const cont = w.submits.at(-1)
    expect(cont?.text).toContain(CONTINUATION)
    expect(cont?.text).toContain('shell b1 finished')
    expect((await arrive($, '<task-notification>later</task-notification>', 'task-notification')).drop).toBeUndefined()
  })
})

describe('a restart that loses the run is reported', () => {
  const KEY = 'run/sid-1'
  const DAY = 24 * 60 * 60 * SEC
  const resumedAnswer = `Saved.\n\n<handoff-note>\n${SAVE_ANSWER}\n</handoff-note>`

  test('a run in progress is kept in the store until it finishes', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    expect(w.store.get(KEY)).toEqual({ phase: 'saving', notePath: NOTE, startedAt: T0 })

    await saveTurn($, w)
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
    expect(w.store.get(KEY)).toBeUndefined()
  })

  test('a finished or cancelled run says nothing at the next start', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await relay($, 'cancel')
    expect(w.store.get(KEY)).toBeUndefined()
    await start($)
    expect(w.logs.some(l => /restart/i.test(l))).toBe(false)
  })

  test('a reload during the save turn keeps the run and its record, and reports nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await $.turn.start({ text: w.submits[0]?.text ?? '', turnId: 'save-1' })
    await start($)
    expect(w.logs.some(l => /restart/i.test(l))).toBe(false)
    expect(w.store.get(KEY)).toBeDefined()
  })

  test('a restart during the save turn reports it, then saves the resumed turn’s note without compacting', async ($, on) => {
    const w = world(on, { store: { [KEY]: { phase: 'saving', notePath: NOTE, startedAt: T0 - 60 * SEC } } })
    await start($)
    expect(w.logs.some(l => /restart/i.test(l) && l.includes('Nothing was compacted'))).toBe(true)
    expect(w.store.get(KEY)).toBeUndefined()

    await $.turn.start({ text: 'Continue the interrupted response', turnId: 'resumed' })
    await $.turn.complete({ answer: resumedAnswer, durationMs: 1, isAborted: false, turnId: 'resumed', reason: 'answer' })
    await w.clock.advance(SEC)

    expect(w.writes).toEqual([{ path: NOTE, text: `${NOTED}\n` }])
    expect(w.calls).toEqual([])
    const last = w.logs.at(-1) ?? ''
    expect(last).toContain(NOTE)
    expect(last).toContain('/compact')
    expect(last).toContain(`@${NOTE}`)
  })

  test('a resumed turn with no handoff note saves nothing, and only the first turn counts', async ($, on) => {
    const w = world(on, { store: { [KEY]: { phase: 'saving', notePath: NOTE, startedAt: T0 } } })
    await start($)
    const logged = w.logs.length
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.turn.complete({ answer: 'no note here', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await $.turn.start({ text: 'y', turnId: 't2' })
    await $.turn.complete({ answer: resumedAnswer, durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
    await w.clock.advance(SEC)
    expect(w.writes).toEqual([])
    expect(w.logs.length).toBe(logged)
  })

  test('a restart after the save turn points to the note already written', async ($, on) => {
    const w = world(on, { store: { [KEY]: { phase: 'continuing', notePath: NOTE, startedAt: T0 } } })
    await start($)
    const msg = w.logs.find(l => /restart/i.test(l)) ?? ''
    expect(msg).toContain(`@${NOTE}`)
    expect(msg).toContain('/compact')
    await $.turn.start({ text: 'x', turnId: 't1' })
    await $.turn.complete({ answer: resumedAnswer, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
    await w.clock.advance(SEC)
    expect(w.writes).toEqual([])
  })

  test('records other sessions left behind are pruned after a week', async ($, on) => {
    const w = world(on, {
      store: {
        'run/old': { phase: 'saving', notePath: NOTE, startedAt: T0 - 8 * DAY },
        'run/recent': { phase: 'saving', notePath: NOTE, startedAt: T0 - DAY },
        lastPrompt: { text: 'p', at: T0 - 30 * DAY, sessionId: 'old' },
      },
    })
    await start($)
    expect(w.store.get('run/old')).toBeUndefined()
    expect(w.store.get('run/recent')).toBeDefined()
    expect(w.store.get('lastPrompt')).toBeDefined()
    expect(w.logs.some(l => /restart/i.test(l))).toBe(false)
  })
})

describe('subagent turns are not the main loop', () => {
  test('a subagent turn that starts after the save turn does not stop the run', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { forkGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    // a background agent the save turn started keeps working while relay forks
    await $.turn.start({ text: '', turnId: 'agent-turn', agentId: 'agent-1' })
    gate.resolve()
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'fork', 'compact', 'fill'])
    expect(w.logs.some(l => /stopped/.test(l))).toBe(false)
  })

  test('a subagent turn does not end the hold the person’s prompt started', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    await arrive($, '<task-notification>shell b1 finished</task-notification>', 'task-notification')
    await arrive($, 'go on', 'composer')
    await arrive($, '<task-notification>shell b2 finished</task-notification>', 'task-notification')
    await $.turn.start({ text: '', turnId: 'agent-turn', agentId: 'agent-1' })
    await w.clock.advance(SEC)
    // b2 follows the person's turn, not a subagent's
    expect(w.submits.some(s => s.text.includes('shell b2 finished') && s.origin === 'plugin')).toBe(false)
    await $.turn.start({ text: 'go on', turnId: 'person' })
    await w.clock.advance(SEC)
    expect(w.submits.some(s => s.text.includes('shell b2 finished') && s.origin === 'plugin')).toBe(true)
  })
})

describe('what relay leaves for the next session', () => {
  test('a note that already names its session is saved as it is', async ($, on) => {
    const w = world(on, { answer: `${SAVE_ANSWER}\n\nSession: abc (searchable)` })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(SEC)
    expect(w.writes[0]?.text).toBe(`${SAVE_ANSWER}\n\nSession: abc (searchable)\n`)
  })

  test('another session saving its prompt meanwhile does not change which prompt is filled', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w)
    await w.clock.advance(0)
    w.store.set('lastPrompt', { text: 'the other session’s prompt', at: T0, sessionId: 'sid-2' })
    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.fills).toEqual([CONTINUATION])
  })

  test('log lines leave the plugin name to the engine', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await saveTurn($, w, 'aborted')
    await w.clock.advance(SEC)
    expect(w.logs.length).toBeGreaterThan(0)
    expect(w.logs.filter(l => l.startsWith('relay:'))).toEqual([])
  })
})

describe('the restart toast', () => {
  test('after the save turn it does not claim nothing was compacted', async ($, on) => {
    const w = world(on, { store: { 'run/sid-1': { phase: 'continuing', notePath: NOTE, startedAt: T0 } } })
    await start($)
    expect(w.toasts.length).toBe(1)
    expect(w.toasts.some(t => /nothing was compacted/.test(t))).toBe(false)
  })
})
