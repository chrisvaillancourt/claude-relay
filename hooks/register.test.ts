import { describe, expect, mock, test } from 'claude-code/testing'
import type { On, SessionCompactResult } from 'claude-code'

import { composeContinuation, forSubmit, promptPathFor, SAVE_MARKER, STALE_NOTE, supersededLine, TOOL } from './prompts'

const T0 = Date.UTC(2026, 9, 7, 15, 0)
const SEC = 1000
const NOTE_TEXT = '# Handoff\n\nStep 2 of 3 done; notes/hub.md is current.'
/** The note as relay saves it: the session id added, so a later session can find this one. */
const NOTED = `${NOTE_TEXT}\n\nSession: sid-1`
/** Where the note lands for T0, a TMPDIR of /tmp/T/ and a project root of /work/my-proj. */
const NOTE = '/tmp/T/claude-relay/my-proj-20261007T150000Z.md'
const HANDOFF = { note: NOTE_TEXT, continuation: 'Resume at step 3; the staging deploy is still running.', files: ['notes/hub.md'] }
/** The continuation prompt relay builds from HANDOFF. */
const PROMPT = composeContinuation(HANDOFF, NOTE)
const TEAMMATE = { kind: 'peer' as const, teammate: 'impl-16204', isVerified: true }

function deferred<T>() {
  let resolve!: (v: T) => void
  const p = new Promise<T>(r => {
    resolve = r
  })
  return { p, resolve }
}

type WorldOpts = {
  turns?: number
  /** How many compaction attempts throw before one succeeds. */
  compactFailures?: number
  compactSkip?: string
  /** Holds the first compaction open until the test resolves it. */
  compactGate?: Promise<void>
  draft?: string
  fillOk?: boolean
  dropSubmit?: (text: string) => string | undefined
  /** Makes the submit reject (the kit skips a throwing mock and rejects with its fallback error). */
  throwSubmit?: (text: string) => boolean
  store?: Record<string, unknown>
  /** TMPDIR as the environment has it; null for unset. */
  tmpdir?: string | null
  /** Files on disk besides the ones the plugin wrote, by path. */
  files?: Record<string, string>
  writeFails?: boolean
  /** The context's size as the status line has it; null for unknown. */
  tokens?: number | null
  /** Holds the context-size lookup open until the test resolves it. */
  usageGate?: Promise<void>
  /** Headless: /compact runs but a hook vetoes it, which the command doesn't report. */
  compactVetoed?: boolean
  /** Holds the write of the run's `armed` record open until the test resolves it. */
  armedRecordGate?: Promise<void>
  /** Holds every notify open until the test resolves it (a slow notification channel). */
  notifyGate?: Promise<void>
  /** Holds a plugin's submit open while it sits in the queue; undefined lets it through. */
  submitGate?: (text: string) => Promise<void> | undefined
  /** Makes the engine refuse to end a turn. */
  abortFails?: boolean
}

/** The engine beneath the plugin, recording what the plugin asked of it, in order. */
const world = (on: On, opts: WorldOpts = {}) => {
  const clock = mock.clock(on, { now: T0 })
  // The store as a map the test can read back (the kit's mock.store keeps its own).
  const store = new Map<string, unknown>(Object.entries(opts.store ?? {}))
  on('store.get', ($, e) => ({ value: store.get(e.key) }))
  on('store.set', async ($, e) => {
    if (opts.armedRecordGate && (e.value as { phase?: string } | null)?.phase === 'armed') await opts.armedRecordGate
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, { HOME: '/home/u', ...(opts.tmpdir === null ? {} : { TMPDIR: opts.tmpdir ?? '/tmp/T/' }) })
  const writes: { path: string; text: string }[] = []
  on('fs.write', ($, e) => {
    if (opts.writeFails) return { deny: 'read-only file system' }
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.read', ($, e) => {
    const file = writes.findLast(w => w.path === e.path)
    const text = file?.text ?? opts.files?.[e.path]
    return text === undefined ? { deny: 'no such file' } : { value: text }
  })
  on('session.root', () => ({ value: '/work/my-proj' }))
  const calls: string[] = []
  const submits: { text: string; asUser?: boolean; origin: string; context?: readonly string[] }[] = []
  /** What the prompt box holds: the person's draft, then whatever the plugin filled. */
  const box = { text: opts.draft ?? '' }
  const compacts: (string | undefined)[] = []
  const fills: string[] = []
  const copies: string[] = []
  const logs: string[] = []
  const toasts: string[] = []
  const received: string[] = []
  let compactFailures = opts.compactFailures ?? 0

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__relay__${e.name}` } }))
  on('tool.call', () => ({ result: 'unhandled' }))
  on('session.id', () => ({ value: 'sid-1' }))
  on('session.turns', () => ({ value: opts.turns ?? 5 }))
  let tokens = opts.tokens === undefined ? 400_000 : opts.tokens
  on('session.usage', async () => {
    if (opts.usageGate) await opts.usageGate
    return { value: { startedAt: T0, context: tokens === null ? {} : { tokens }, rateLimits: {}, cost: {} } as never }
  })
  on('session.receive', ($, e) => {
    received.push(e.text)
    return { text: e.text }
  })
  on('prompt.submit', ($, e) => {
    calls.push('submit')
    submits.push({
      text: e.text,
      asUser: e.origin.kind === 'plugin' ? e.origin.asUser : undefined,
      origin: e.origin.kind,
      context: e.context,
    })
    if (opts.throwSubmit?.(e.text)) throw new Error('submit failed')
    const queued = e.origin.kind === 'plugin' ? opts.submitGate?.(e.text) : undefined
    if (queued) return queued.then(() => ({ text: e.text, origin: e.origin }))
    const drop = opts.dropSubmit?.(e.text)
    if (drop !== undefined) return { drop }
    return { text: e.text, origin: e.origin }
  })
  on('prompt.read', () => ({ value: { text: box.text, cursor: 0 } }))
  on('session.append', ($, e, next) => next(e))
  const aborts: string[] = []
  on('turn.abort', ($, e) => {
    if (opts.abortFails) throw new Error('not the running turn')
    aborts.push(e.turnId)
    return { value: undefined }
  })
  let compactGate = opts.compactGate
  const runCompaction = async (instructions: string | undefined): Promise<SessionCompactResult> => {
    compacts.push(instructions)
    if (compactGate) {
      const gate = compactGate
      compactGate = undefined
      await gate
    }
    if (compactFailures > 0) {
      compactFailures--
      throw new Error('compaction failed')
    }
    if (opts.compactSkip) return { skip: opts.compactSkip }
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }
  }
  on('session.compact', ($, e) => {
    calls.push('compact')
    return runCompaction(e.instructions)
  })
  on('command.run', { command: 'compact' }, async ($, e) => {
    calls.push('/compact')
    if (opts.compactVetoed) return { text: '' }
    await runCompaction(e.args)
    if (tokens !== null) tokens = 3_000
    return { text: '' }
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
  const notifies: { text: string; title?: string }[] = []
  on('ui.notify', async ($, e) => {
    notifies.push({ text: e.text, title: e.title })
    if (opts.notifyGate) await opts.notifyGate
    // what a detached background session answers; its Notification hooks still hear it
    return { value: { isSent: false as const, reason: 'no-channel' as const } }
  })

  return { clock, calls, submits, compacts, fills, copies, logs, toasts, notifies, writes, received, box, store, aborts }
}

type World = ReturnType<typeof world>

/** A prompt the engine queued from somewhere other than the plugin: a background task, or the person's Enter. */
const arrive = ($: any, text: string, kind: 'task-notification' | 'peer' | 'composer', turnId?: string) =>
  $.prompt.submit({ text, origin: { kind }, wait: false, ...(turnId ? { turnId } : {}) })

/** A teammate's message reaching the session's mailbox. */
const teammate = ($: any, text: string, extra: Record<string, unknown> = {}) => $.session.receive({ origin: TEAMMATE, text, ...extra })

const COMMAND = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } }

const start = async ($: any, isInteractive = true) => {
  await $.session.start({ cwd: '/x', surface: isInteractive ? 'terminal' : null, isInteractive })
}

const relay = ($: any, args = '') => $.command.run({ command: 'relay', args, ...COMMAND })

/** The model calling the handoff tool. */
const handoff = async ($: any, input: Record<string, unknown> = HANDOFF, agentId?: string): Promise<string> =>
  (await $.tool.call({ tool: TOOL, tool_use_id: 'tu1', ...input, ...(agentId ? { agentId } : {}) })).result

const turnStart = ($: any, turnId: string, text = 'work') => $.turn.start({ text, turnId })

/** A prompt queued over the running turn being attached to it, where the model's next step reads it. */
const attach = ($: any, text: string, extra: Record<string, unknown> = {}) =>
  $.session.append({
    door: 'attachment',
    origin: { kind: 'composer' },
    uuid: 'row-1',
    message: { type: 'attachment', name: 'queued_command', content: [{ type: 'text', text: `The user sent a new message while you were working:\n${text}` }] },
    ...extra,
  })

const turnEnd = ($: any, turnId: string, reason: 'answer' | 'aborted' = 'answer') =>
  $.turn.complete({ answer: 'Saved.', durationMs: 30 * SEC, isAborted: reason === 'aborted', turnId, reason })

/** /relay, then the save turn up to the model's handoff call; the turn is still running. */
const saveTurnArmed = async ($: any, w: World, args = '') => {
  await relay($, args)
  await w.clock.advance(0)
  await turnStart($, 'save-1', w.submits.at(-1)?.text ?? '')
  return handoff($)
}

/** A whole /relay run: the save turn calls the tool and ends, and the timers run. */
const relayRun = async ($: any, w: World, args = '') => {
  await saveTurnArmed($, w, args)
  await turnEnd($, 'save-1')
  await w.clock.advance(SEC)
}

/** The agent hands off by itself, in a turn of its own work; the turn is still running. */
const agentArmed = async ($: any) => {
  await turnStart($, 'work-1')
  return handoff($)
}

const agentRun = async ($: any, w: World) => {
  await agentArmed($)
  await turnEnd($, 'work-1')
  await w.clock.advance(SEC)
}

const runDone = (w: World) => w.logs.filter(l => l.startsWith('run done'))
const notCompacted = (texts: readonly (string | undefined)[]) => texts.some(t => /NOT compacted/.test(t ?? ''))

describe('/relay', () => {
  test('the save turn hands off through the tool; relay compacts, then fills the prompt box', async ($, on) => {
    const w = world(on)
    await start($)

    const r = await relay($, 'stress the rollback plan')
    expect(r.text).toMatch(/saving/i)
    await w.clock.advance(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.text.startsWith(SAVE_MARKER)).toBe(true)
    expect(w.submits[0]?.text).toContain('stress the rollback plan')
    expect(w.submits[0]?.text).toContain(TOOL)
    expect(w.submits[0]?.asUser).toBe(true)

    await turnStart($, 'save-1', w.submits[0]?.text)
    const answer = await handoff($)
    expect(answer).toContain(NOTE)
    expect(answer).toMatch(/End your turn now/)
    expect(answer).toMatch(/prompt box/)
    // nothing compacts while the turn runs
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit'])

    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['submit', 'compact', 'fill'])
    expect(w.writes).toEqual([
      { path: NOTE, text: `${NOTED}\n` },
      { path: promptPathFor(NOTE), text: `${PROMPT}\n` },
    ])
    expect(w.compacts[0]?.startsWith("Keep any information that's helpful to the agent and not written to a durable location.")).toBe(true)
    expect(w.compacts[0]).toContain(NOTE)
    expect(w.fills).toEqual([PROMPT])
    expect(w.copies).toEqual([PROMPT])
    expect(PROMPT).toContain(`@${NOTE}\n@notes/hub.md`)

    expect((await relay($, 'status')).text).toMatch(/idle/i)
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=delivered deliver=fill source=person'])
  })

  test('a note longer than 8,000 characters is saved whole, and the prompt never calls it cut', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    const tail = 'TAIL-MARKER: the last gotcha'
    await handoff($, { ...HANDOFF, note: `${'x'.repeat(12_000)}\n${tail}` })
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)

    expect(w.writes[0]?.text).toContain(tail)
    expect(w.fills[0]).not.toMatch(/truncated|\[…\]/)
  })

  test('a turn that is not the save turn does not end the run', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)

    await turnStart($, 'other', 'something else')
    await turnEnd($, 'other')
    await w.clock.advance(SEC)
    expect((await relay($, 'status')).text).toMatch(/saving/i)

    await turnStart($, 'save-1', w.submits[0]?.text)
    await handoff($)
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'compact', 'fill'])
  })

  test('a save turn that ends without the tool call stops the run, and the next prompt tells the model', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit'])
    expect(w.logs.some(l => /without calling/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
    expect(runDone(w)).toEqual(['run done phase=saving outcome=stopped deliver=fill source=person'])

    await arrive($, 'carry on', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
    // told once
    await arrive($, 'and then', 'composer')
    expect(w.submits.at(-1)?.context).toBeUndefined()
  })

  test('an interrupted save turn stops the run before anything is compacted', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await turnEnd($, 'save-1', 'aborted')
    await w.clock.advance(5 * SEC)

    expect(w.calls).toEqual(['submit'])
    expect(w.logs.some(l => /stopped: the turn ended \(aborted\)/.test(l))).toBe(true)
    expect(runDone(w)).toEqual(['run done phase=armed outcome=stopped deliver=fill source=person'])
  })

  test('a subagent turn never continues the run, and its tool call saves nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    expect(await handoff($, HANDOFF, 'agent-1')).toMatch(/only the main conversation/)
    expect(w.writes.length).toBe(0)

    await handoff($)
    await $.turn.complete({ answer: 'sub', durationMs: 1, isAborted: false, turnId: 'sub-1', reason: 'answer', agentId: 'agent-1' })
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
  })

  test('a call without a note saves nothing and leaves the run waiting', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    expect(await handoff($, { continuation: 'go on' })).toMatch(/Nothing was saved/)
    expect(w.writes.length).toBe(0)
    expect(await handoff($)).toContain(NOTE)
  })

  test('a second tool call in the same turn changes nothing', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    expect(await handoff($, { ...HANDOFF, continuation: 'something else' })).toMatch(/already saved/)
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)
    expect(w.fills).toEqual([PROMPT])
  })

  test('retries a rejected compaction', async ($, on) => {
    const w = world(on, { compactFailures: 2 })
    await start($)
    await relayRun($, w)
    await w.clock.advance(10 * SEC)

    // the box is filled once, as the first attempt starts
    expect(w.calls).toEqual(['submit', 'compact', 'fill', 'compact', 'compact'])
    expect(w.toasts.some(t => /review the prompt/.test(t))).toBe(true)
  })

  test('gives up on compaction after its retries; the prompt in the box then tells the model nothing was compacted', async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($)
    await relayRun($, w)
    await w.clock.advance(5 * 60 * SEC)

    expect(w.compacts.length).toBe(3)
    expect(w.fills).toEqual([PROMPT])
    expect(w.logs.some(l => /couldn't compact/.test(l) && /prompt box/.test(l) && /\/compact/.test(l))).toBe(true)
    expect(w.notifies.length).toBe(1)

    await arrive($, PROMPT, 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
  })

  test('gives up on compaction after its retries, keeps the prompt and fills nothing', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($)
    await relayRun($, w)
    await w.clock.advance(5 * 60 * SEC)

    expect(w.compacts.length).toBe(3)
    expect(w.fills.length).toBe(0)
    expect(w.logs.some(l => /\/relay paste/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)

    await relay($, 'paste')
    expect(w.fills).toEqual([PROMPT])
  })

  test('a skipped compaction fills nothing and says why', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { compactSkip: 'blocked by a PreCompact hook' })
    await start($)
    await relayRun($, w)
    await w.clock.advance(5 * SEC)

    expect(w.fills.length).toBe(0)
    expect(w.logs.some(l => l.includes('blocked by a PreCompact hook'))).toBe(true)
  })

  test('submit mode sends the prompt and tells the model to read the files', { options: { deliver: 'submit' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)

    expect(w.fills.length).toBe(0)
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.text).toBe(forSubmit(PROMPT))
    expect(w.submits[1]?.asUser).toBe(true)
  })

  test('custom compaction instructions and no clipboard', { options: { compactInstructions: 'Keep the plan.', copyToClipboard: false } }, async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)

    expect(w.compacts[0]?.startsWith('Keep the plan.\n\n')).toBe(true)
    expect(w.copies.length).toBe(0)
  })

  test('an instructions file replaces the compaction instructions, read when the compaction starts', { options: { compactInstructions: 'Keep the plan.', instructionsFile: ' ~/hooks/compact.md ' } }, async ($, on) => {
    const w = world(on, { files: { '/home/u/hooks/compact.md': 'Keep ids exactly.\n' } })
    await start($)
    await relayRun($, w)

    expect(w.compacts[0]?.startsWith('Keep ids exactly.\n\nA handoff note is saved at ')).toBe(true)
  })

  test('an instructions file that is missing or empty falls back to the compaction instructions, and the log says so', { options: { compactInstructions: 'Keep the plan.', instructionsFile: '/nope/compact.md' } }, async ($, on) => {
    const w = world(on, { files: { '/nope/other.md': 'x' } })
    await start($)
    await relayRun($, w)

    expect(w.compacts[0]?.startsWith('Keep the plan.\n\n')).toBe(true)
    expect(w.logs.some(l => l.includes('/nope/compact.md'))).toBe(true)
    expect(w.calls).toEqual(['submit', 'compact', 'fill'])
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
    expect((await relay($)).text).toMatch(/already/i)
    expect(w.submits.length).toBe(1)
  })

  test('cancel during the save turn: a handoff call that follows saves nothing and starts no run', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    expect((await relay($, 'cancel')).text).toMatch(/cancelled/i)

    expect(await handoff($)).toMatch(/No handoff will run/)
    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)
    expect(w.writes.length).toBe(0)
    expect(w.compacts.length).toBe(0)
    expect(runDone(w)).toEqual(['run done phase=saving outcome=cancelled deliver=fill source=person'])
  })

  test('cancel after the handoff call stops the compaction, and the next prompt tells the model', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await relay($, 'cancel')
    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)

    await arrive($, 'carry on', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
  })

  test('refuses to start in an empty conversation', async ($, on) => {
    const w = world(on, { turns: 0 })
    await start($)
    expect((await relay($)).text).toMatch(/nothing to hand off/i)
    expect(w.submits.length).toBe(0)
  })

  test('paste refills the last saved prompt, even from another session', async ($, on) => {
    const w = world(on, { store: { lastPrompt: { text: 'Continue from @notes/x.md', at: T0, sessionId: 'other' } } })
    await start($)
    expect((await relay($, 'paste')).text).toMatch(/session other/)
    expect(w.fills).toEqual(['Continue from @notes/x.md'])
  })

  test('paste with nothing saved says so', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await relay($, 'paste')).text).toMatch(/no saved/i)
    expect(w.fills.length).toBe(0)
  })

  test("a person's prompt that arrives before the compaction stops the run and tells the model", async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await arrive($, 'actually, look at the deploy first', 'composer', 'save-1')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)

    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    expect(w.logs.some(l => /your prompt arrived before the compaction/.test(l))).toBe(true)
    // the model was told by the prompt itself, so relay starts no turn of its own
    expect(w.submits.filter(s => s.origin === 'plugin').length).toBe(1)
  })

  test('a reload before the turn ends keeps the run, which then delivers from the prompt saved beside the note', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    // a hot reload runs register and session.start again; `$.state` survives it
    await start($)
    expect(w.logs.some(l => /reload/.test(l))).toBe(false)
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'compact', 'fill'])
    expect(w.fills).toEqual([PROMPT])
  })

  test('a reload during the compaction resets the run and says where its files are', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relayRun($, w)
    expect((await relay($, 'status')).text).toMatch(/compacting/i)

    await start($)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
    expect(w.logs.some(l => /a plugin reload came/.test(l) && l.includes(promptPathFor(NOTE)))).toBe(true)
    gate.resolve()
  })

  test('a save turn the marker never matched times out instead of hanging', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', 'rewritten by another plugin')
    await w.clock.advance(6 * SEC)

    expect(w.logs.some(l => /couldn't find the save turn/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('a dropped save prompt stops the run', async ($, on) => {
    const w = world(on, { dropSubmit: () => 'blocked by a hook' })
    await start($)
    await relay($)
    await w.clock.advance(0)

    expect(w.logs.some(l => /blocked by a hook/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('filling keeps a draft the person typed, after the continuation prompt', async ($, on) => {
    const w = world(on, { draft: 'also check the logs' })
    await start($)
    await relayRun($, w)
    expect(w.fills).toEqual([`${PROMPT}\n\nalso check the logs`])
  })

  test('a box that refuses the fill gets the prompt in the transcript', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { fillOk: false })
    await start($)
    await relayRun($, w)

    expect(w.logs.some(l => l.includes("couldn't fill the prompt box") && l.includes(PROMPT))).toBe(true)
    // the conversation was compacted, so nothing says otherwise
    await arrive($, PROMPT, 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(false)
  })

  test('submit mode: a dropped continuation prompt is reported', { options: { deliver: 'submit' } }, async ($, on) => {
    const w = world(on, { dropSubmit: text => (text.includes('Come up to speed') ? 'blocked' : undefined) })
    await start($)
    await relayRun($, w)
    expect(w.logs.some(l => /continuation prompt was refused \(blocked\)/.test(l))).toBe(true)
  })

  test('a note that cannot be written saves nothing, tells the model and ends the run', async ($, on) => {
    const w = world(on, { writeFails: true })
    await start($)
    const answer = await saveTurnArmed($, w)
    expect(answer).toMatch(/Nothing was saved/)
    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)

    expect(w.compacts.length).toBe(0)
    expect(w.logs.some(l => /couldn't write the handoff note/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('with no TMPDIR the note goes under /tmp', async ($, on) => {
    const w = world(on, { tmpdir: null })
    await start($)
    await relayRun($, w)
    expect(w.writes[0]?.path).toBe('/tmp/claude-relay/my-proj-20261007T150000Z.md')
  })

  test('noteDir overrides the temp directory', { options: { noteDir: '/scratch/handoffs/' } }, async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    expect(w.writes[0]?.path).toBe('/scratch/handoffs/my-proj-20261007T150000Z.md')
  })
})

describe('the agent hands off by itself', () => {
  test('its call saves the note, the turn end compacts, and the continuation is sent with nobody at the box', async ($, on) => {
    const w = world(on)
    await start($)
    const answer = await agentArmed($)
    expect(answer).toContain(NOTE)
    expect(answer).toMatch(/sends the continuation prompt/)
    await turnEnd($, 'work-1')
    await w.clock.advance(SEC)

    expect(w.calls).toEqual(['compact', 'submit'])
    expect(w.writes[0]).toEqual({ path: NOTE, text: `${NOTED}\n` })
    expect(w.submits[0]?.text).toBe(forSubmit(PROMPT))
    expect(w.submits[0]?.asUser).toBe(true)
    // the default is fill, but the agent's run has nobody to press Enter; and it leaves the clipboard alone
    expect(w.fills.length).toBe(0)
    expect(w.copies.length).toBe(0)
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=delivered deliver=submit source=agent'])
  })

  test('a small context is declined, and nothing changes', { options: { minTokens: 150_000 } }, async ($, on) => {
    const w = world(on, { tokens: 90_000 })
    await start($)
    expect(await agentArmed($)).toMatch(/under relay's 150000-token floor/)
    await turnEnd($, 'work-1')
    await w.clock.advance(SEC)
    expect(w.writes.length).toBe(0)
    expect(w.compacts.length).toBe(0)
  })

  test('the floor is for the agent alone: /relay hands off at any size', async ($, on) => {
    const w = world(on, { tokens: 10_000 })
    await start($)
    await relayRun($, w)
    expect(w.calls).toEqual(['submit', 'compact', 'fill'])
  })

  test('a context of unknown size is not declined', async ($, on) => {
    const w = world(on, { tokens: null })
    await start($)
    await agentRun($, w)
    expect(w.calls).toEqual(['compact', 'submit'])
  })

  test('a compaction that fails is told to the model, which had been promised one', async ($, on) => {
    const w = world(on, { compactSkip: 'blocked by a PreCompact hook' })
    await start($)
    await agentRun($, w)

    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.origin).toBe('plugin')
    expect(w.submits[0]?.asUser).toBeUndefined()
    expect(w.submits[0]?.text).toMatch(/NOT compacted/)
    expect(w.submits[0]?.text).toContain('blocked by a PreCompact hook')
    expect(w.submits[0]?.text).toContain(NOTE)
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=stopped deliver=submit source=agent'])
  })

  test('an interrupted turn stops the run and tells the model', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1', 'aborted')
    await w.clock.advance(SEC)
    expect(w.compacts.length).toBe(0)
    expect(notCompacted(w.submits.map(s => s.text))).toBe(true)
  })

  test('headless: the turn end compacts through /compact and sends the continuation', async ($, on) => {
    const w = world(on)
    await start($, false)
    await agentArmed($)
    await turnEnd($, 'work-1')

    expect(w.calls).toEqual(['/compact', 'submit'])
    expect(w.submits[0]?.text).toBe(forSubmit(PROMPT))
  })
})

describe('a turn that starts before the compaction', () => {
  test('a teammate message queued before the handoff runs its turn first; relay compacts when it ends and says so', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    // the engine starts the queued message's turn before relay's timer runs
    await turnStart($, 'mate-1', 'Another Claude session sent a message: …')
    await w.clock.advance(5 * SEC)
    expect(w.calls).toEqual([])
    expect((await relay($, 'status')).text).toMatch(/compacting/i)

    await turnEnd($, 'mate-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'submit'])
    expect(w.submits[0]?.text).toBe(forSubmit(composeContinuation(HANDOFF, NOTE, true)))
    expect(w.submits[0]?.text).toContain(STALE_NOTE)
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=delivered deliver=submit source=agent'])
  })

  test('the same in a /relay run: the box is filled once the waited-for turn ends', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await turnEnd($, 'save-1')
    await turnStart($, 'mate-1')
    await w.clock.advance(5 * SEC)
    expect(w.calls).toEqual(['submit'])

    await turnEnd($, 'mate-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'compact', 'fill'])
    expect(w.fills).toEqual([composeContinuation(HANDOFF, NOTE, true)])
  })

  test('a compaction refused because a turn slipped in waits for that turn instead of giving up', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactFailures: 1, compactGate: gate.p })
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    await w.clock.advance(0)
    expect(w.calls).toEqual(['compact'])
    await turnStart($, 'mate-1')
    gate.resolve()
    await w.clock.advance(60 * SEC)
    expect(w.calls).toEqual(['compact'])

    await turnEnd($, 'mate-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'compact', 'submit'])
  })

  test('turns that keep starting stop the run after three waits, and the model is told', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    for (const id of ['m1', 'm2', 'm3', 'm4']) {
      await turnStart($, id)
      await w.clock.advance(SEC)
      await turnEnd($, id)
    }
    await w.clock.advance(SEC)

    expect(w.compacts.length).toBe(0)
    expect(w.logs.some(l => /new turns kept starting/.test(l))).toBe(true)
    expect(notCompacted(w.submits.map(s => s.text))).toBe(true)
  })

  test('a waited-for turn the person interrupts stops the run', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    await turnStart($, 'mate-1')
    await w.clock.advance(SEC)
    await turnEnd($, 'mate-1', 'aborted')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test("a person's prompt while relay waits stops the run", async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    await turnStart($, 'mate-1')
    await w.clock.advance(SEC)
    await arrive($, 'stop, do this instead', 'composer', 'mate-1')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
    await turnEnd($, 'mate-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
  })

  test('a subagent turn is not the main loop: the compaction does not wait for it', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    await $.turn.start({ text: 'sub', turnId: 'sub-1', agentId: 'agent-1' })
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'submit'])
    expect(w.submits[0]?.text).not.toContain(STALE_NOTE)
  })

  test('a prompt sent from the box while compaction retries is reported as run uncompacted, not waited for', async ($, on) => {
    const w = world(on, { compactFailures: 1 })
    await start($)
    await relayRun($, w)
    expect(w.fills).toEqual([PROMPT])
    await arrive($, PROMPT, 'composer')
    await turnStart($, 'cont-1', PROMPT)
    await w.clock.advance(5 * SEC)
    await turnEnd($, 'cont-1')
    await w.clock.advance(5 * SEC)

    expect(w.compacts.length).toBe(1)
    expect(w.logs.some(l => /ran on the uncompacted conversation/.test(l))).toBe(true)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
  })

  test('the continuation queued during the compaction is not taken for an interruption', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relayRun($, w)
    expect(w.fills).toEqual([PROMPT])
    // Enter during the compaction queues the prompt
    await arrive($, PROMPT, 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(false)
    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.toasts.at(-1)).toBe('compacted; review the prompt and press Enter')
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=delivered deliver=fill source=person'])
  })
})

describe('deliveries wait for the continuation prompt', () => {
  test('a teammate message after the handoff is held and rides with the continuation, under its sender’s name', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    // one that lands while the turn still runs would start a turn of its own once it ends
    const midTurn = await teammate($, 'PLAT-16204 implement: done.')
    expect(midTurn.consumed).toMatch(/holding/)
    await turnEnd($, 'work-1')
    const idle = await teammate($, '{"type":"idle_notification","from":"impl-16204"}')
    expect(idle.consumed).toMatch(/holding/)
    await w.clock.advance(SEC)

    expect(w.received).toEqual([])
    expect(w.calls).toEqual(['compact', 'submit'])
    expect(w.submits[0]?.text).toContain('Message from teammate impl-16204:\nPLAT-16204 implement: done.')
    expect(w.submits[0]?.text).toContain('idle_notification')
    // once the continuation's turn has started, the next one passes
    await turnStart($, 'cont-1', w.submits[0]?.text)
    expect((await teammate($, 'later')).text).toBe('later')
    expect(w.received).toEqual(['later'])
  })

  test('in a /relay run the held teammate message goes with the person’s prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    expect((await teammate($, 'review done')).consumed).toBeDefined()
    expect((await relay($, 'status')).text).toMatch(/holding 1 background message/i)

    await arrive($, PROMPT, 'composer')
    expect(w.submits.at(-1)?.context?.[0]).toContain('Message from teammate impl-16204:\nreview done')
  })

  test('with no handoff, a teammate message passes; so does one for a subagent, or from no teammate', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await teammate($, 'hello')).text).toBe('hello')
    await agentArmed($)
    expect((await teammate($, 'for a worker', { agentId: 'agent-1' })).text).toBe('for a worker')
    expect((await $.session.receive({ origin: { kind: 'task-notification' }, text: 'a relay event' })).text).toBe('a relay event')
    expect(w.received).toEqual(['hello', 'for a worker', 'a relay event'])
  })

  test('a notification after the handoff is held, then rides along with the person’s prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)

    const held = await arrive($, '<task-notification>build done</task-notification>', 'task-notification')
    expect(held.drop).toMatch(/holding/)
    const second = await arrive($, 'peer says hi', 'peer')
    expect(second.drop).toMatch(/holding/)

    const sent = await arrive($, PROMPT, 'composer')
    expect(sent.drop).toBeUndefined()
    const context = w.submits.at(-1)?.context ?? []
    expect(context.length).toBe(1)
    expect(context[0]).toContain('build done')
    expect(context[0]?.indexOf('build done')).toBeLessThan(context[0]?.indexOf('peer says hi') ?? -1)
  })

  test('a notification delivered into a running turn passes through', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    const r = await arrive($, 'into the turn', 'task-notification', 'save-1')
    expect(r.drop).toBeUndefined()
  })

  test('no run, no hold', async ($, on) => {
    world(on)
    await start($)
    expect((await arrive($, 'bg', 'task-notification')).drop).toBeUndefined()
  })

  test('cancel releases what was held', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    await arrive($, 'bg one', 'task-notification')
    await teammate($, 'mate one')

    expect((await relay($, 'cancel')).text).toMatch(/released 2 held messages/i)
    await w.clock.advance(0)
    expect(w.submits.at(-1)?.origin).toBe('plugin')
    expect(w.submits.at(-1)?.text).toContain('bg one')
    expect(w.submits.at(-1)?.text).toContain('mate one')
    expect((await arrive($, 'bg two', 'task-notification')).drop).toBeUndefined()
  })

  test('a run that stops without a prompt in the box releases what was held', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { compactSkip: 'no' })
    await start($)
    await saveTurnArmed($, w)
    await teammate($, 'mate one')
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)

    expect(w.submits.at(-1)?.origin).toBe('plugin')
    expect(w.submits.at(-1)?.text).toContain('mate one')
    // the turn relay starts for the hand-back must not run believing in a compaction: told there, once
    expect(w.submits.at(-1)?.text).toMatch(/NOT compacted/)
    await arrive($, 'carry on', 'composer')
    expect(w.submits.at(-1)?.context).toBeUndefined()
  })

  test('a person’s prompt refused further down keeps what was held', async ($, on) => {
    const w = world(on, { dropSubmit: text => (text === 'blocked prompt' ? 'a hook said no' : undefined) })
    await start($)
    await relayRun($, w)
    await arrive($, 'bg', 'task-notification')

    expect((await arrive($, 'blocked prompt', 'composer')).drop).toBe('a hook said no')
    await arrive($, PROMPT, 'composer')
    expect(w.submits.at(-1)?.context?.[0]).toContain('bg')
  })

  test('the hold lasts until the person’s turn starts; what arrives in between follows that turn', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    await arrive($, PROMPT, 'composer')
    expect((await arrive($, 'late one', 'task-notification')).drop).toMatch(/holding/)

    await turnStart($, 'cont-1', PROMPT)
    await w.clock.advance(0)
    expect(w.submits.at(-1)?.origin).toBe('plugin')
    expect(w.submits.at(-1)?.text).toContain('late one')
    expect((await arrive($, 'after', 'task-notification')).drop).toBeUndefined()
  })

  test('a subagent turn does not end the hold the person’s prompt started', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    await arrive($, PROMPT, 'composer')
    await $.turn.start({ text: 'sub', turnId: 'sub-1', agentId: 'agent-1' })
    expect((await arrive($, 'late', 'task-notification')).drop).toMatch(/holding/)
  })

  test('a plugin’s prompt neither is held nor ends the hold', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    const r = await $.prompt.submit({ text: 'from another plugin', origin: { kind: 'plugin', name: 'other' }, wait: false })
    expect(r.drop).toBeUndefined()
    expect((await arrive($, 'bg', 'task-notification')).drop).toMatch(/holding/)
  })

  test('a new /relay carries what is still held into its save prompt', async ($, on) => {
    const w = world(on)
    await start($)
    await relayRun($, w)
    await arrive($, 'bg kept', 'task-notification')

    await w.clock.advance(60 * SEC)
    await relay($)
    await w.clock.advance(0)
    expect(w.submits.at(-1)?.text.startsWith(SAVE_MARKER)).toBe(true)
    expect(w.submits.at(-1)?.text).toContain('bg kept')
  })

  test('held messages handed back and refused further down go to the transcript', async ($, on) => {
    const w = world(on, { dropSubmit: text => (text.includes('relay held these') ? 'refused' : undefined) })
    await start($)
    await relayRun($, w)
    await arrive($, 'bg lost?', 'task-notification')
    await relay($, 'cancel')
    await w.clock.advance(0)
    expect(w.logs.some(l => /couldn't hand back 1 held message \(refused\)/.test(l) && l.includes('bg lost?'))).toBe(true)
  })

  test('a fill that fails at delivery keeps holding, since the prompt is still to be sent', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const w = world(on, { fillOk: false })
    await start($)
    await relayRun($, w)
    expect((await arrive($, 'bg', 'task-notification')).drop).toMatch(/holding/)
  })

  test('submit mode: the held notifications ride along with the continuation prompt', { options: { deliver: 'submit' } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relayRun($, w)
    await arrive($, 'bg during compaction', 'task-notification')
    gate.resolve()
    await w.clock.advance(SEC)

    expect(w.submits.at(-1)?.text).toContain(PROMPT)
    expect(w.submits.at(-1)?.text).toContain('bg during compaction')
  })

  test('submit mode: the hold lasts until the continuation’s turn starts; what arrives in between follows that turn', async ($, on) => {
    const w = world(on)
    await start($)
    await agentRun($, w)
    const sent = w.submits.at(-1)?.text ?? ''
    expect(sent).toBe(forSubmit(PROMPT))
    // dequeued as the session went idle after the compaction, before the continuation's turn started
    expect((await arrive($, 'hand-back queued during the compaction', 'peer')).drop).toMatch(/holding/)
    expect(w.store.get('held/sid-1')).toEqual(['hand-back queued during the compaction'])
    // greppable in the debug log: what was held, and whether the compaction had finished
    expect(w.logs).toContain('held a peer delivery (run idle, compaction done)')

    await turnStart($, 'cont-1', sent)
    await w.clock.advance(0)
    expect(w.submits.at(-1)?.origin).toBe('plugin')
    expect(w.submits.at(-1)?.text).toContain('hand-back queued during the compaction')
    expect((await arrive($, 'after', 'task-notification')).drop).toBeUndefined()
  })

  test('a delivery stamped with a turn that has ended would start a turn of its own, so it is held', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    await w.clock.advance(0)
    expect((await arrive($, 'stamped late', 'peer', 'work-1')).drop).toMatch(/holding/)
    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.submits.at(-1)?.text).toContain('stamped late')
  })

  test('submit mode: a refused continuation hands back what arrived while it was being sent', async ($, on) => {
    let arrived: Promise<{ drop?: string }> | null = null
    const w = world(on, {
      dropSubmit: text => {
        if (!text.includes('Come up to speed')) return undefined
        arrived = arrive($, 'arrived mid-submit', 'task-notification')
        return 'refused'
      },
    })
    await start($)
    await agentRun($, w)
    await w.clock.advance(SEC)
    expect((await arrived!).drop).toMatch(/holding/)
    expect(w.submits.some(s => s.origin === 'plugin' && s.text.includes('arrived mid-submit'))).toBe(true)
    expect((await arrive($, 'after', 'task-notification')).drop).toBeUndefined()
  })

  test('submit mode: a continuation submit that fails logs what it carried', { options: { deliver: 'submit' } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p, throwSubmit: text => text.includes('Come up to speed') })
    await start($)
    await relayRun($, w)
    await arrive($, 'bg carried', 'task-notification')
    gate.resolve()
    await w.clock.advance(SEC)

    expect(w.logs.some(l => /continuation prompt was refused/.test(l))).toBe(true)
    expect(w.logs.some(l => /couldn't hand back 1 held message/.test(l) && l.includes('bg carried'))).toBe(true)
  })
})

describe('a restart that loses the run is reported', () => {
  const RECORD_KEY = 'run/sid-1'

  test('a run in progress is kept in the store until it finishes', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    expect(w.store.get(RECORD_KEY)).toEqual({ phase: 'saving', notePath: NOTE, startedAt: T0, source: 'person' })

    await turnStart($, 'save-1', w.submits[0]?.text)
    await handoff($)
    expect(w.store.get(RECORD_KEY)).toEqual({ phase: 'armed', notePath: NOTE, startedAt: T0, source: 'person' })

    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)
    expect(w.store.has(RECORD_KEY)).toBe(false)
  })

  test('a finished or cancelled run says nothing at the next start', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await relay($, 'cancel')
    expect(w.store.has(RECORD_KEY)).toBe(false)
    await start($)
    expect(w.notifies.length).toBe(0)
  })

  test('a restart during the save turn is logged, toasted and notified once', async ($, on) => {
    const w = world(on, { store: { [RECORD_KEY]: { phase: 'saving', notePath: NOTE, startedAt: T0 } } })
    await start($)

    expect(w.logs.some(l => /restarted this session during the save turn/.test(l))).toBe(true)
    expect(w.toasts).toEqual(['a restart interrupted /relay; nothing was compacted'])
    expect(w.notifies).toEqual([{ text: 'a restart interrupted /relay; nothing was compacted', title: 'relay' }])
    expect(w.store.has(RECORD_KEY)).toBe(false)
    // the person's run is theirs to pick up: relay starts no turn
    await w.clock.advance(SEC)
    expect(w.submits.length).toBe(0)
  })

  test("a restart that loses the agent's own run tells the model, since nobody may be watching", async ($, on) => {
    const w = world(on, { store: { [RECORD_KEY]: { phase: 'continuing', notePath: NOTE, startedAt: T0, source: 'agent' } } })
    await start($)
    await w.clock.advance(0)

    expect(w.toasts).toEqual(['a restart interrupted /relay; see the log'])
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.origin).toBe('plugin')
    expect(w.submits[0]?.text).toMatch(/may not have been compacted/)
    expect(w.submits[0]?.text).toContain(NOTE)
    expect(w.submits[0]?.text).toContain(promptPathFor(NOTE))
  })

  test('no record, no notification', async ($, on) => {
    const w = world(on)
    await start($)
    expect(w.notifies.length).toBe(0)
    expect(w.toasts.length).toBe(0)
  })

  test('a notification channel that never answers does not hold up the start', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { notifyGate: gate.p, store: { [RECORD_KEY]: { phase: 'saving', notePath: NOTE, startedAt: T0 } } })
    await start($)
    expect(w.notifies.length).toBe(1)
    expect((await relay($, 'status')).text).toMatch(/idle/i)
    gate.resolve()
  })

  test('records other sessions left behind are pruned after a week', async ($, on) => {
    const week = 7 * 24 * 60 * 60 * SEC
    const w = world(on, {
      store: {
        'run/old': { phase: 'saving', notePath: NOTE, startedAt: T0 - week - SEC },
        'run/recent': { phase: 'continuing', notePath: NOTE, startedAt: T0 - SEC },
        'run/garbage': 'nope',
        lastPrompt: { text: 'x', at: T0, sessionId: 'other' },
      },
    })
    await start($)
    expect([...w.store.keys()].sort()).toEqual(['lastPrompt', 'run/recent'])
  })
})

describe('races and recoveries', () => {
  test('a cancel that lands while the handoff is being recorded leaves no hold behind', async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { armedRecordGate: gate.p })
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    const answering = handoff($)
    await w.clock.advance(0)
    await relay($, 'cancel')
    gate.resolve()

    expect(await answering).toMatch(/No handoff will run/)
    expect((await relay($, 'status')).text).toBe('Idle.')
    expect((await teammate($, 'report')).text).toBe('report')
    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
  })

  test("a person's prompt queued during the save turn, before the tool call, stops the run", async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    await arrive($, 'look at the deploy first', 'composer', 'save-1')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)

    expect(await handoff($)).toMatch(/No handoff will run/)
    await turnEnd($, 'save-1')
    await turnStart($, 'person-1', 'look at the deploy first')
    await turnEnd($, 'person-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    expect(w.fills.length).toBe(0)
    // the block lasts for that turn only
    await turnStart($, 'work-2')
    expect(await handoff($)).toMatch(/Handoff saved/)
  })

  test('a cancel before the save prompt’s turn starts still blocks that turn’s handoff call', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await relay($, 'cancel')
    await turnStart($, 'save-1', w.submits[0]?.text)
    expect(await handoff($)).toMatch(/No handoff will run/)
    expect(w.writes.length).toBe(0)
  })

  test('a reload does not forget that this turn’s /relay was cancelled', async ($, on) => {
    const w = world(on)
    await start($)
    await relay($)
    await w.clock.advance(0)
    await turnStart($, 'save-1', w.submits[0]?.text)
    await relay($, 'cancel')
    await start($)
    expect(await handoff($)).toMatch(/No handoff will run/)
    await turnEnd($, 'save-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
  })

  test('a boxed prompt sent and finished between compaction retries is not compacted over', async ($, on) => {
    const w = world(on, { compactFailures: 1 })
    await start($)
    await relayRun($, w)
    expect(w.fills).toEqual([PROMPT])
    await arrive($, PROMPT, 'composer')
    await turnStart($, 'cont-1', PROMPT)
    await turnEnd($, 'cont-1')
    await w.clock.advance(10 * SEC)

    expect(w.compacts.length).toBe(1)
    expect(w.logs.some(l => /ran on the uncompacted conversation/.test(l))).toBe(true)
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=stopped deliver=fill source=person'])
  })

  test('headless: a failed compaction tells the model before the turn hook returns, with no timer', async ($, on) => {
    const w = world(on, { compactFailures: 1000 })
    await start($, false)
    await agentArmed($)
    await teammate($, 'held report')
    await turnEnd($, 'work-1')

    expect(w.calls).toEqual(['/compact', 'submit'])
    expect(w.submits[0]?.text).toMatch(/NOT compacted/)
    expect(w.submits[0]?.text).toContain('held report')
  })

  test("the agent's continuation refused after the compaction is not called delivered, and the model is pointed at the saved prompt", async ($, on) => {
    const w = world(on, { dropSubmit: text => (text.includes('Come up to speed') ? 'blocked by a hook' : undefined) })
    await start($)
    await agentArmed($)
    await teammate($, 'held report')
    await turnEnd($, 'work-1')
    await w.clock.advance(SEC)

    expect(runDone(w)).toEqual(['run done phase=continuing outcome=stopped deliver=submit source=agent'])
    expect(w.submits.length).toBe(2)
    expect(w.submits[1]?.text).toContain(promptPathFor(NOTE))
    expect(w.submits[1]?.text).toContain('held report')
    expect(w.submits[1]?.text).not.toMatch(/NOT compacted/)
    expect(w.store.has('run/sid-1')).toBe(false)
  })

  test("the agent's handoff is refused in a turn the person has typed over", async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($, 'work-1')
    await arrive($, 'stop and do X instead', 'composer', 'work-1')
    expect(await handoff($)).toMatch(/may not have read/)
    await turnEnd($, 'work-1')
    await turnStart($, 'person-1', 'stop and do X instead')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    // their turn is a turn like any other
    expect(await handoff($)).toMatch(/Handoff saved/)
  })

  test("a person's prompt between compaction retries, with nothing in the box, stops the run", async ($, on) => {
    const w = world(on, { compactFailures: 1 })
    await start($)
    await agentRun($, w)
    expect(w.compacts.length).toBe(1)
    await arrive($, 'do this instead', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
    await turnStart($, 'person-1', 'do this instead')
    await turnEnd($, 'person-1')
    await w.clock.advance(10 * SEC)
    expect(w.compacts.length).toBe(1)
    expect(w.submits.filter(s => s.origin === 'plugin').length).toBe(0)
  })

  test("a person's prompt while the compaction is in flight is queued behind it, and the run goes on", async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await agentRun($, w)
    await arrive($, 'while you are at it', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(false)
    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.submits.at(-1)?.text).toBe(forSubmit(PROMPT))
  })

  test('cancel while the compaction waits for a turn tells the model', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    await turnStart($, 'mate-1')
    await w.clock.advance(SEC)
    await relay($, 'cancel')
    await turnEnd($, 'mate-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    await arrive($, 'carry on', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
  })

  test('a restart during the save turn: the resumed turn’s handoff call starts no run', async ($, on) => {
    const w = world(on, { store: { 'run/sid-1': { phase: 'saving', notePath: NOTE, startedAt: T0, source: 'person' } } })
    await start($)
    expect(await handoff($)).toMatch(/No handoff will run/)
    expect(w.writes.length).toBe(0)
  })

  test("a person's prompt typed while the handoff call reads the context's size still blocks it", async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { usageGate: gate.p })
    await start($)
    await turnStart($, 'work-1')
    const answering = handoff($)
    await w.clock.advance(0)
    await arrive($, 'stop and do X instead', 'composer', 'work-1')
    gate.resolve()
    expect(await answering).toMatch(/may not have read/)
    await turnEnd($, 'work-1')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
  })

  test('cancel with messages held: the turn that hands them back is told nothing was compacted', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await teammate($, 'held report')
    await relay($, 'cancel')
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)
    expect(w.submits.at(-1)?.origin).toBe('plugin')
    expect(w.submits.at(-1)?.text).toContain('held report')
    expect(w.submits.at(-1)?.text).toMatch(/NOT compacted/)
  })

  test("a reload that resets the person's run with messages held tells the hand-back's turn", async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await teammate($, 'held report')
    await turnEnd($, 'save-1')
    await start($)
    await w.clock.advance(SEC)
    expect(w.submits.at(-1)?.text).toContain('held report')
    expect(w.submits.at(-1)?.text).toMatch(/may not have been compacted/)
  })

  test('headless: a /compact that a hook vetoed is not taken for a compaction', async ($, on) => {
    const w = world(on, { compactVetoed: true })
    await start($, false)
    await agentArmed($)
    await turnEnd($, 'work-1')
    expect(w.calls).toEqual(['/compact', 'submit'])
    expect(w.submits[0]?.text).toMatch(/NOT compacted/)
    expect(w.submits[0]?.text).toContain('the context did not shrink')
  })

  test('headless: with the context size unknown, relay does not compact, since it could not tell a veto from a compaction', async ($, on) => {
    const w = world(on, { tokens: null, compactVetoed: true })
    await start($, false)
    await agentArmed($)
    await turnEnd($, 'work-1')
    expect(w.calls).toEqual(['submit'])
    expect(w.submits[0]?.text).toMatch(/NOT compacted/)
    expect(w.submits[0]?.text).toContain('context size is unavailable')
  })

  test('cancel after a skipped compaction left the prompt in the box: the hand-back carries the waiting notice', async ($, on) => {
    const w = world(on, { compactSkip: 'blocked by a PreCompact hook' })
    await start($)
    await saveTurnArmed($, w)
    await teammate($, 'held report')
    await turnEnd($, 'save-1')
    await w.clock.advance(SEC)
    expect(notCompacted(w.submits.map(s => s.text))).toBe(false)
    await relay($, 'cancel')
    await w.clock.advance(SEC)
    expect(w.submits.at(-1)?.text).toContain('held report')
    expect(w.submits.at(-1)?.text).toMatch(/NOT compacted/)
  })

  test('several deliveries held at once are all in the store', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await Promise.all([teammate($, 'one'), arrive($, 'two', 'task-notification'), teammate($, 'three')])
    expect((w.store.get('held/sid-1') as string[]).length).toBe(3)
  })

  test('cancel after the turn ended but before the compaction still tells the model', async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await turnEnd($, 'save-1')
    await relay($, 'cancel')
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    await arrive($, 'carry on', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
  })

  test("a reload that resets the person's run leaves a correction for their next prompt", async ($, on) => {
    const w = world(on)
    await start($)
    await saveTurnArmed($, w)
    await turnEnd($, 'save-1')
    await start($)
    await w.clock.advance(5 * SEC)
    expect(w.compacts.length).toBe(0)
    await arrive($, 'carry on', 'composer')
    expect(w.submits.at(-1)?.context?.some(c => /may not have been compacted/.test(c))).toBe(true)
  })

  test('what is held is kept in the store too, and a new process hands it back', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await teammate($, 'the only copy')
    expect(w.store.get('held/sid-1')).toEqual(['Message from teammate impl-16204:\nthe only copy'])
    await turnEnd($, 'work-1')
    await w.clock.advance(SEC)
    expect(w.store.has('held/sid-1')).toBe(false)
  })

  test('a restart hands back what the lost process was holding', async ($, on) => {
    const w = world(on, { store: { 'held/sid-1': ['Message from teammate impl-16204:\nthe only copy'] } })
    await start($)
    await w.clock.advance(0)
    expect(w.submits.length).toBe(1)
    expect(w.submits[0]?.text).toContain('the only copy')
    expect(w.store.has('held/sid-1')).toBe(false)
  })

  test("a restart that loses the person's run after the handoff leaves a correction for their next prompt", async ($, on) => {
    const w = world(on, { store: { 'run/sid-1': { phase: 'armed', notePath: NOTE, startedAt: T0, source: 'person' } } })
    await start($)
    await arrive($, 'carry on', 'composer')
    expect(notCompacted(w.submits.at(-1)?.context ?? [])).toBe(true)
  })
})

describe("a prompt typed over the turn blocks a handoff only until the model has read it", () => {
  test('once the prompt is attached to the turn, the handoff the person asked for goes through', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($, 'work-1')
    await arrive($, 'finish up, then hand off and compact before new work', 'composer', 'work-1')
    // another row attached to the turn says nothing about the prompt
    await attach($, 'a background task finished')
    expect(await handoff($)).toMatch(/may not have read/)

    await arrive($, 'and commit first', 'composer', 'work-1')
    await attach($, 'and commit first')
    expect(await handoff($)).toMatch(/Handoff saved/)
    await turnEnd($, 'work-1')
    await w.clock.advance(SEC)
    // the person's two prompts, then relay's compaction and continuation
    expect(w.calls).toEqual(['submit', 'submit', 'compact', 'submit'])
  })

  test('a refused call is the last one refused for that prompt, which the model reads with the refusal', async ($, on) => {
    world(on)
    await start($)
    await turnStart($, 'work-1')
    await arrive($, 'also update the docs', 'composer', 'work-1')
    expect(await handoff($)).toMatch(/may not have read/)
    expect(await handoff($)).toMatch(/Handoff saved/)
  })

  test("a subagent's attached row does not count as the main conversation reading the prompt", async ($, on) => {
    world(on)
    await start($)
    await turnStart($, 'work-1')
    await arrive($, 'also update the docs', 'composer', 'work-1')
    await attach($, 'also update the docs', { agentId: 'agent-1' })
    expect(await handoff($)).toMatch(/may not have read/)
  })

  test('a prompt the person asked to wait its turn does not block: it runs after the turn, and the compaction waits for it', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($, 'work-1')
    await $.prompt.submit({ text: 'next, look at Y', origin: { kind: 'composer' }, wait: true, turnId: 'work-1' })
    expect(await handoff($)).toMatch(/Handoff saved/)
    await turnEnd($, 'work-1')
    await turnStart($, 'person-1', 'next, look at Y')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit'])
    await turnEnd($, 'person-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['submit', 'compact', 'submit'])
    expect(w.submits.at(-1)?.text).toContain(STALE_NOTE)
  })
})

describe('a handoff call while an earlier run is still going', () => {
  const HANDOFF_2 = { note: '# Handoff\n\nStep 3 done too.', continuation: 'Resume at step 4.', files: [] }

  test('in the turn the compaction waits for, the newer note and prompt take the place of the older', async ($, on) => {
    const w = world(on)
    await start($)
    await agentArmed($)
    await turnEnd($, 'work-1')
    // a message queued before the hold starts a turn first
    await turnStart($, 'mate-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual([])

    const answer = await handoff($, HANDOFF_2)
    expect(answer).toMatch(/in place of the one saved before this turn/)
    expect(answer).toContain(NOTE)
    await turnEnd($, 'mate-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'submit'])
    expect(w.writes.findLast(x => x.path === NOTE)?.text).toContain('Step 3 done too.')
    // the newer note covers the turn, so the prompt doesn't call it stale
    expect(w.submits[0]?.text).toBe(forSubmit(composeContinuation(HANDOFF_2, NOTE)))
    expect(runDone(w)).toEqual(['run done phase=continuing outcome=delivered deliver=submit source=agent'])
  })

  /** The agent's run has compacted and its continuation sits in the queue behind a turn the person started. */
  const queuedBehindATurn = async ($: any, on: On, opts: WorldOpts = {}) => {
    const queue = deferred<void>()
    const w = world(on, { ...opts, submitGate: text => (text === forSubmit(PROMPT) ? queue.p : undefined) })
    await start($)
    await agentRun($, w)
    expect(w.calls).toEqual(['compact', 'submit'])
    await turnStart($, 'person-1', 'one more thing first')
    return { w, queue }
  }
  const NOTE_2 = '/tmp/T/claude-relay/my-proj-20261007T150001Z.md'

  test('with its continuation still queued, a new handoff starts a run of its own, and the queued prompt’s turn is cut short', async ($, on) => {
    const { w, queue } = await queuedBehindATurn($, on)
    const answer = await handoff($, HANDOFF_2)
    expect(answer).toMatch(/Handoff saved/)
    expect(answer).toContain(NOTE_2)
    expect(w.writes.find(x => x.path === NOTE_2)?.text).toContain('Step 3 done too.')

    await turnEnd($, 'person-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'submit', 'compact', 'submit'])
    const sent = w.submits.at(-1)?.text ?? ''
    expect(sent).toContain(composeContinuation(HANDOFF_2, NOTE_2))
    expect(sent).toContain(supersededLine(NOTE))

    // the older prompt comes off the queue first: its turn ends at once, and the hold stays for the newer one
    await turnStart($, 'old-1', forSubmit(PROMPT))
    await w.clock.advance(0)
    expect(w.aborts).toEqual(['old-1'])
    expect((await arrive($, 'bg', 'task-notification')).drop).toMatch(/holding/)
    await turnEnd($, 'old-1', 'aborted')
    queue.resolve()
    await w.clock.advance(SEC)
    expect(w.logs.some(l => /stopped|refused/.test(l))).toBe(false)

    await turnStart($, 'cont-2', sent)
    await w.clock.advance(0)
    expect(w.submits.at(-1)?.text).toContain('bg')
    expect(w.aborts).toEqual(['old-1'])
  })

  test('the queued prompt’s turn starting before the newer compaction is cut short and waited out, and the note is no staler for it', async ($, on) => {
    const { w } = await queuedBehindATurn($, on)
    await handoff($, HANDOFF_2)
    await turnEnd($, 'person-1')
    await turnStart($, 'old-1', forSubmit(PROMPT))
    await w.clock.advance(SEC)
    expect(w.aborts).toEqual(['old-1'])
    expect(w.calls).toEqual(['compact', 'submit'])

    await turnEnd($, 'old-1', 'aborted')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'submit', 'compact', 'submit'])
    expect(w.submits.at(-1)?.text).not.toContain(STALE_NOTE)
    expect(notCompacted(w.submits.map(x => x.text))).toBe(false)
  })

  test('a turn that cannot be cut short runs, and the newer run still compacts after it', async ($, on) => {
    const { w } = await queuedBehindATurn($, on, { abortFails: true })
    await handoff($, HANDOFF_2)
    await turnEnd($, 'person-1')
    await turnStart($, 'old-1', forSubmit(PROMPT))
    await w.clock.advance(SEC)
    expect(w.logs.some(l => /couldn't cut the replaced prompt's turn short/.test(l))).toBe(true)
    await turnEnd($, 'old-1')
    await w.clock.advance(SEC)
    expect(w.calls).toEqual(['compact', 'submit', 'compact', 'submit'])
  })

  test('a newer run that stops leaves the queued prompt to run', async ($, on) => {
    const { w } = await queuedBehindATurn($, on)
    await handoff($, HANDOFF_2)
    await turnEnd($, 'person-1', 'aborted')
    await w.clock.advance(SEC)
    await turnStart($, 'old-1', forSubmit(PROMPT))
    await w.clock.advance(SEC)
    expect(w.aborts).toEqual([])
  })

  test("a person's prompt that mentions the replaced note is not cut short", async ($, on) => {
    const { w } = await queuedBehindATurn($, on)
    await handoff($, HANDOFF_2)
    await turnEnd($, 'person-1')
    await w.clock.advance(SEC)
    await turnStart($, 'person-2', `what does @${NOTE} say?`)
    await w.clock.advance(SEC)
    expect(w.aborts).toEqual([])
  })

  test('a second call in the handoff’s own turn, or while the compaction runs, still changes nothing', async ($, on) => {
    world(on)
    await start($)
    await agentArmed($)
    expect(await handoff($, HANDOFF_2)).toMatch(/already saved/)
  })
})

describe('what relay leaves for after the compaction', () => {
  test('a note that already names this session is saved as it is', async ($, on) => {
    const w = world(on)
    await start($)
    await turnStart($, 'work-1')
    await handoff($, { ...HANDOFF, note: `${NOTE_TEXT}\n\nSession: sid-1` })
    expect(w.writes[0]?.text).toBe(`${NOTED}\n`)
  })

  test('another session saving its prompt meanwhile does not change which prompt is filled', { options: { fillDuringCompaction: false } }, async ($, on) => {
    const gate = deferred<void>()
    const w = world(on, { compactGate: gate.p })
    await start($)
    await relayRun($, w)
    w.store.set('lastPrompt', { text: 'another session’s prompt', at: T0, sessionId: 'other' })
    gate.resolve()
    await w.clock.advance(SEC)
    expect(w.fills).toEqual([PROMPT])
  })

  test('log lines leave the plugin name to the engine', async ($, on) => {
    const w = world(on, { compactSkip: 'no' })
    await start($)
    await relayRun($, w)
    expect(w.logs.length).toBeGreaterThan(0)
    expect(w.logs.some(l => l.startsWith('relay:'))).toBe(false)
  })
})
