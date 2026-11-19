import { atom, read, update } from 'claude-code'
import type { CommandSpec, EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import {
  acceptedText,
  ALREADY_TEXT,
  belowMinText,
  CANCELLED_TEXT,
  heldKey,
  compactInstructionsFor,
  composeContinuation,
  forSubmit,
  heldNotice,
  holdAppend,
  isCanceled,
  isHeldOrigin,
  isPersonOrigin,
  isRunRecord,
  lostRunNotice,
  notCompactedNotice,
  notePathFor,
  parseArgs,
  parseHandoff,
  promptPathFor,
  restoreHold,
  RUN_KEY_PREFIX,
  runKey,
  SAVE_MARKER,
  savePrompt,
  STALE_NOTE,
  SUBAGENT_TEXT,
  teammateItem,
  TOOL,
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_SCHEMA,
  UNSAVED_TEXT,
  withSession,
} from './prompts'
import type { Handoff } from './prompts'
import type { Config, Deliver, Hold, Run, RunRecord, SavedPrompt } from '../types'

/** A rejected compaction is retried briefly, then given up. */
const COMPACT_RETRY_MS = 2000
const COMPACT_ATTEMPTS = 3
/** How many turns that started first a compaction waits out before the run stops. */
const MAX_DEFERRALS = 3
/** How long after the save prompt's turn started to expect its turn.start to have been matched. */
const SAVE_TURN_WATCHDOG_MS = 5000
/** Run records older than this, from sessions never resumed, are dropped at session start. */
const RUN_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_COMPACT_INSTRUCTIONS =
  "Keep any information that's helpful to the agent and not written to a durable location."
const DEFAULT_MIN_TOKENS = 100_000

const IDLE: Run = {
  phase: 'idle',
  runId: 0,
  saveTurnId: null,
  startedAt: null,
  notePath: null,
  source: 'person',
  deferrals: 0,
  isStale: false,
  isBlocked: false,
}

// The shape tags change with the types: a value an older version stored (it
// outlives a hot reload) then reads as the initial one instead of breaking.
const runAtom = atom({ plugin: 'relay', key: 'run' } as const, IDLE, { shape: 'run-2' })

const RELEASED: Hold = { isHolding: false, items: [], endsAtTurn: false, gen: 0, notice: null }
const holdAtom = atom({ plugin: 'relay', key: 'hold' } as const, RELEASED, { shape: 'hold-2' })

// Module variables reset on a hot reload; `$.state` survives one. A run left
// `continuing` by a reload has lost its timer, so session.start resets it.
let config: Config = configFrom({})
let timer: Timer | null = null
/** The run whose continuation prompt went into the box as compaction started. */
let filledEarlyRunId: number | null = null
/**
 * The run whose compaction is in flight (`pending`) or went through (`done`).
 * Before either, a turn or a person's prompt got in ahead of the compaction;
 * after, it is the continuation's or simply queued behind it. A rejection clears it.
 */
let compaction: { runId: number; state: 'pending' | 'done' } | null = null
/** The run whose compaction waits for a running turn to end. */
let waitingRunId: number | null = null
let isInteractive = true
/** The tail of the writes that mirror the hold to `$.store`. */
let heldWrites: Promise<void> = Promise.resolve()
/** Whether a main-loop turn is running. */
let isTurnRunning = false
/** The run whose boxed prompt may have been sent: a main-loop turn started after the box was filled. */
let sentEarlyRunId: number | null = null
/**
 * This run's handoff. `lastPrompt` in `$.store` is shared by every session,
 * so another session's run could overwrite it before this one delivers.
 */
let runHandoff: { runId: number; handoff: Pick<Handoff, 'continuation' | 'files'> } | null = null

function configFrom(options: PluginOptions): Config {
  const instructions = typeof options.compactInstructions === 'string' ? options.compactInstructions.trim() : ''
  const minTokens = typeof options.minTokens === 'number' && options.minTokens >= 0 ? options.minTokens : DEFAULT_MIN_TOKENS
  return {
    deliver: options.deliver === 'submit' ? 'submit' : 'fill',
    compactInstructions: instructions || DEFAULT_COMPACT_INSTRUCTIONS,
    copyToClipboard: options.copyToClipboard !== false,
    noteDir: typeof options.noteDir === 'string' ? options.noteDir.trim() : '',
    saveInstructions: typeof options.saveInstructions === 'string' ? options.saveInstructions.trim() : '',
    instructionsFile: typeof options.instructionsFile === 'string' ? options.instructionsFile.trim() : '',
    fillDuringCompaction: options.fillDuringCompaction !== false,
    minTokens,
  }
}

/** A run the agent started has nobody at the prompt box, so its continuation is always sent. */
function deliverMode(run: Run): Deliver {
  return run.source === 'agent' ? 'submit' : config.deliver
}

/** Ends the hold and returns what it held; a notice for the person's next prompt stays. */
async function release($: EngineInterface): Promise<string[]> {
  let items: string[] = []
  await update($, holdAtom, cur => {
    items = cur.items
    return { ...RELEASED, gen: (cur.gen ?? 0) + 1, notice: cur.notice ?? null }
  })
  await saveHeld($)
  return items
}

/**
 * Takes what's held for relay's own prompt to carry, and keeps holding until
 * that prompt's turn starts. Releasing before the submit left a gap: a delivery
 * queued during the compaction is dequeued as the session goes idle, and started
 * a turn of its own ahead of the continuation (seen 2026-11-18 on 2.1.327).
 * What's held from here on follows the turn (`turn.start`).
 */
async function takeHeld($: EngineInterface): Promise<string[]> {
  let items: string[] = []
  await update($, holdAtom, cur => {
    items = cur.isHolding ? cur.items : []
    return cur.isHolding ? { ...cur, items: [], endsAtTurn: true } : cur
  })
  await saveHeld($)
  return items
}

/**
 * Keeps what's held in `$.store` too. A consumed delivery is in no queue and
 * no transcript, so the hold in `$.state` would be its only copy, and a new
 * process loses `$.state`. Best effort.
 */
function saveHeld($: EngineInterface): Promise<void> {
  // One write at a time, each of the hold as it stands when the write runs:
  // an older snapshot finishing late would otherwise replace a newer one.
  heldWrites = heldWrites.then(async () => {
    try {
      const { isHolding, items } = await read($, holdAtom)
      const key = heldKey(await $.session.id())
      if (isHolding && items.length) await $.store.set(key, [...items])
      else await $.store.delete(key)
    } catch {
      // Best effort.
    }
  })
  return heldWrites
}

/** Hands back what a lost process was holding for this session. */
async function restoreLostHeld($: EngineInterface) {
  try {
    if ((await read($, holdAtom)).isHolding) return
    const key = heldKey(await $.session.id())
    const stored = await $.store.get(key)
    if (stored === undefined) return
    await $.store.delete(key)
    const items = Array.isArray(stored) ? stored.filter((i): i is string => typeof i === 'string') : []
    await submitLater($, null, items)
  } catch {
    // Best effort.
  }
}

/** Puts held messages that couldn't be handed back in the transcript, so they aren't lost. */
function logHeld($: EngineInterface, items: readonly string[], why: string) {
  if (!items.length) return
  try {
    $.ui.log(`couldn't hand back ${items.length} held message${items.length === 1 ? '' : 's'} (${why}). Here they are:\n\n${heldNotice(items)}`)
  } catch {
    // Best effort.
  }
}

/**
 * Sends the model relay's own message, with any held deliveries: it runs once
 * the session is idle. From a timer, since a hook that submits would wait on
 * itself. A refusal goes to the log in full.
 */
function submitLater($: EngineInterface, notice: string | null, held: readonly string[]): Promise<void> {
  const parts = [...(notice ? [notice] : []), ...(held.length ? [heldNotice(held)] : [])]
  if (!parts.length) return Promise.resolve()
  const refused = (why: string) => {
    logHeld($, held, why)
    if (notice) {
      try {
        $.ui.log(`couldn't tell the model (${why}): ${notice}`)
      } catch {
        // Best effort.
      }
    }
  }
  const send = () =>
    $.prompt
      .submit({ text: parts.join('\n\n') })
      .then(r => {
        if (r.drop !== undefined) refused(r.drop)
      })
      .catch(err => refused(errorText(err)))
  // A headless process exits when the turn does, before a timer would fire.
  if (!isInteractive) return send()
  $.clock.after(0, () => void send())
  return Promise.resolve()
}

/** Ends the hold and hands what it held back to the session as relay's own message. */
async function releaseToSession($: EngineInterface): Promise<number> {
  return handBack($, null, false)
}

/**
 * Ends the hold and hands back what it held, with `notice` for the model:
 * in relay's own message when `submit` is set or there are deliveries to
 * hand back (the turn that message starts must not run believing in a
 * compaction), else with the person's next prompt. A notice still waiting
 * for the person's prompt (an earlier stop that kept the hold) goes the same
 * way when the caller has none.
 */
async function handBack($: EngineInterface, notice: string | null, submit: boolean): Promise<number> {
  const waiting = (await read($, holdAtom)).notice ?? null
  const held = await release($)
  const viaSubmit = submit || held.length > 0
  const text = notice ?? waiting
  if (viaSubmit ? waiting : text) await update($, holdAtom, cur => ({ ...cur, notice: viaSubmit ? null : text }))
  await submitLater($, viaSubmit ? text : null, held)
  return held.length
}

/** Keeps the run in progress in `$.store`, so a new process can tell it was lost; best effort. */
async function recordRun($: EngineInterface, record: RunRecord) {
  try {
    await $.store.set(runKey(await $.session.id()), record)
  } catch {
    // Best effort.
  }
}

async function forgetRun($: EngineInterface) {
  try {
    await $.store.delete(runKey(await $.session.id()))
  } catch {
    // Best effort.
  }
}

/**
 * In a process with no run in `$.state`, a run record means the process that
 * started the run is gone (an upgrade, a background session moved to another
 * host, a crash and resume), and its timers with it: say so instead of going
 * quiet. The agent's own run is told to the model too, since nobody may be
 * watching.
 */
async function reportLostRun($: EngineInterface) {
  try {
    const record = await $.store.get(runKey(await $.session.id()))
    if (record === undefined) return
    await forgetRun($)
    if (!isRunRecord(record)) return
    const notice = lostRunNotice(record, 'restart')
    $.ui.log(notice)
    // After the turn ended, compaction may have run before the old process died.
    const text = record.phase === 'continuing' ? 'a restart interrupted /relay; see the log' : 'a restart interrupted /relay; nothing was compacted'
    toast($, text)
    notify($, text)
    if (record.phase === 'saving') await update($, runAtom, cur => ({ ...cur, isBlocked: true }))
    if (record.source === 'agent') await submitLater($, notice, [])
    // The person's next prompt carries it to the model, which may still expect a compaction.
    else if (record.phase !== 'saving') await update($, holdAtom, cur => ({ ...cur, notice }))
  } catch {
    // Reporting must never throw out of a hook.
  }
}

/** Drops run records other sessions left behind and never came back to. */
async function pruneRuns($: EngineInterface) {
  try {
    const cutoff = (await $.clock.now()) - RUN_RECORD_TTL_MS
    for (const key of await $.store.keys()) {
      if (!key.startsWith(RUN_KEY_PREFIX)) continue
      const record = await $.store.get(key)
      if (!isRunRecord(record) || record.startedAt < cutoff) await $.store.delete(key)
    }
  } catch {
    // Best effort.
  }
}

function cancelTimer() {
  timer?.cancel()
  timer = null
}

function errorText(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function toast($: EngineInterface, text: string) {
  try {
    $.ui.toast(text)
  } catch {
    // Best effort.
  }
}

/**
 * Raises a desktop notification without waiting for it. A detached `--bg`
 * session answers `no-channel`, but the person's `Notification` hooks still
 * hear it, which is how someone away from that session learns of it.
 */
function notify($: EngineInterface, text: string) {
  try {
    void $.ui.notify(text).catch(() => {
      // Best effort.
    })
  } catch {
    // Best effort.
  }
}

/**
 * The one debug-log line each run ends with (grep `run done`): the phase it
 * reached, how it ended (delivered: the continuation went into the box or was
 * sent; stopped: a failure, with its message logged next; cancelled: /relay
 * cancel), how it delivers and who started it.
 */
function logRunDone($: EngineInterface, run: Run, outcome: 'delivered' | 'stopped' | 'cancelled') {
  try {
    $.ui.log(`run done phase=${run.phase} outcome=${outcome} deliver=${deliverMode(run)} source=${run.source}`, { to: 'debug' })
  } catch {
    // Best effort.
  }
}

type FinishOptions = {
  /** The continuation prompt is still to be sent, so the hold stays for it. */
  keepHold?: boolean
  /** The compaction went through, so the model needn't be told it didn't. */
  isCompacted?: boolean
  /**
   * How the model learns the run stopped without compacting. `submit`:
   * relay's own message, which starts a turn (the default for the agent's
   * run, where nobody else would). `notice`: with the person's next prompt
   * (the default for the person's). `none`: the caller tells it.
   */
  tell?: 'submit' | 'notice' | 'none'
  /** Refuse a handoff call for the rest of the running turn: its save prompt no longer stands. */
  block?: boolean
}

/** Ends run `runId` if it is still the live one, and says why; never throws. */
async function finish($: EngineInterface, runId: number, message: string | null, options: FinishOptions = {}) {
  try {
    const run = await read($, runAtom)
    if (run.runId !== runId || run.phase === 'idle') return
    await update($, runAtom, cur => (cur.runId === runId ? { ...IDLE, runId, isBlocked: options.block ?? cur.isBlocked } : cur))
    await forgetRun($)
    if (waitingRunId === runId) waitingRunId = null
    $.ui.status(undefined)
    logRunDone($, run, message === null ? 'delivered' : 'stopped')
    if (message === null) return
    $.ui.log(message)
    const tell = options.isCompacted ? 'none' : (options.tell ?? (run.source === 'agent' ? 'submit' : 'notice'))
    const notice = tell === 'none' ? null : notCompactedNotice(message, run.notePath)
    if (!options.isCompacted) {
      toast($, 'the handoff stopped; nothing was compacted (see the log)')
      notify($, 'relay stopped before compacting; see the log')
    }
    // A failure leaves no continuation prompt to wait for, unless it's already in the box.
    if (options.keepHold || filledEarlyRunId === runId) {
      if (notice && tell === 'notice') await update($, holdAtom, cur => ({ ...cur, notice }))
      else await submitLater($, notice, [])
    } else {
      await handBack($, notice, tell === 'submit')
    }
  } catch {
    // Reporting must never throw out of a hook or timer.
  }
}

async function isCurrent($: EngineInterface, runId: number) {
  const run = await read($, runAtom)
  return run.runId === runId && run.phase === 'continuing'
}

/** Puts `text` in the prompt box ahead of any draft the person has typed. */
async function fill($: EngineInterface, text: string): Promise<boolean> {
  const draft = (await $.prompt.read()).text.trim()
  const filled = await $.prompt.fill({ text: draft ? `${text}\n\n${draft}` : text })
  return filled.isFilled
}

/**
 * The run's continuation prompt as it should be delivered now. A reload
 * drops the module's copy; the one written beside the note stands in.
 */
async function promptText($: EngineInterface, run: Run): Promise<string> {
  if (run.notePath === null) return ''
  if (runHandoff?.runId === run.runId) return composeContinuation(runHandoff.handoff, run.notePath, run.isStale)
  try {
    const saved = await $.fs.read(promptPathFor(run.notePath))
    const text = typeof saved === 'string' ? saved.trim() : ''
    return text && run.isStale ? `${text}\n\n${STALE_NOTE}` : text
  } catch {
    return ''
  }
}

/**
 * What the person wants the summary to keep: the instructions file's text when
 * one is set and readable, else `compactInstructions`. Read at each compaction,
 * so an edit to the file needs no reload.
 */
async function baseInstructions($: EngineInterface): Promise<string> {
  if (!config.instructionsFile) return config.compactInstructions
  let path = config.instructionsFile
  try {
    if (path === '~' || path.startsWith('~/')) path = `${(await $.env.get('HOME')) ?? '~'}${path.slice(1)}`
    const content = await $.fs.read(path)
    const text = typeof content === 'string' ? content.trim() : ''
    if (text) return text
    $.ui.log(`instructions file ${path} is empty; compacting with compactInstructions`)
  } catch (err) {
    $.ui.log(`instructions file ${path} unreadable (${errorText(err)}); compacting with compactInstructions`)
  }
  return config.compactInstructions
}

/** One compaction; a headless session refuses `$.session.compact`, and runs /compact instead. */
async function compactOnce($: EngineInterface, instructions: string): Promise<{ skip?: string }> {
  if (isInteractive) {
    const r = await $.session.compact({ instructions })
    return r.skip === undefined ? {} : { skip: r.skip }
  }
  // /compact run this way reports no skip (a PreCompact hook's veto), so the context's size has to say.
  // Without a size to compare with, a veto would pass for a compaction, so relay doesn't compact at all.
  const before = await contextTokens($)
  if (before === null) return { skip: 'the context size is unavailable, so a compaction could not be confirmed' }
  await $.command.run({ command: 'compact', args: instructions })
  // A compaction clears the size until the next response, so none afterwards is not a veto.
  const after = await contextTokens($)
  return after !== null && after >= before ? { skip: 'the context did not shrink' } : {}
}

/** Runs `step` once the current hook has returned (a timer), or at once where timers don't outlive the turn. */
function soon($: EngineInterface, runId: number, step: () => Promise<void>) {
  const run = () => step().catch(err => finish($, runId, `stopped: ${errorText(err)}`))
  if (!isInteractive) return run()
  cancelTimer()
  timer = $.clock.after(0, () => void run())
  return Promise.resolve()
}

/**
 * A turn that no person started (a teammate's message queued before the
 * hold) is running, and a compaction would be refused: wait for it to end.
 * The compaction summary then covers that turn, and the prompt says so.
 */
async function deferCompaction($: EngineInterface, runId: number) {
  const run = await update($, runAtom, cur => (cur.runId === runId ? { ...cur, deferrals: cur.deferrals + 1, isStale: true } : cur))
  if (run.runId !== runId || run.phase !== 'continuing') return
  if (run.deferrals > MAX_DEFERRALS) {
    await finish($, runId, `stopped: new turns kept starting before the compaction (${MAX_DEFERRALS} in a row). Nothing was compacted.`)
    return
  }
  waitingRunId = runId
  $.ui.status('a turn started first; compacting when it ends…')
  $.ui.log(`compaction deferred (${run.deferrals}): a turn is running`, { to: 'debug' })
}

/** Compacts, waiting out a turn that started first and retrying a rejection briefly. */
async function compact($: EngineInterface, runId: number, attempt = 1): Promise<void> {
  if (!(await isCurrent($, runId))) return
  // With the prompt already in the box, a turn since is taken for that prompt's, running or
  // already over: compacting now could compact over its work. (It may be a queued teammate
  // message's instead; stopping is the safe reading, since nothing is compacted.)
  if (isTurnRunning || sentEarlyRunId === runId) {
    if (filledEarlyRunId === runId) {
      await finish(
        $,
        runId,
        'stopped: a turn started while compaction was retrying. If it was the continuation prompt, it ran on the uncompacted conversation; /compact, then /relay paste, to start over.',
      )
      return
    }
    await deferCompaction($, runId)
    return
  }
  const run = await read($, runAtom)
  const mode = deliverMode(run)
  const instructions = compactInstructionsFor(await baseInstructions($), run.notePath ?? '')
  let result
  try {
    compaction = { runId, state: 'pending' }
    const compacting = compactOnce($, instructions)
    if (mode === 'fill' && config.fillDuringCompaction && filledEarlyRunId !== runId) {
      // The prompt goes in as compaction starts, so the person can queue it
      // before a background task finishes. Its rejection is awaited below.
      compacting.catch(() => undefined)
      if (await fillSaved($, run)) {
        filledEarlyRunId = runId
        $.ui.status('compacting… the continuation prompt is in the box; Enter queues it')
      }
    }
    result = await compacting
  } catch (err) {
    if (compaction?.runId === runId) compaction = null
    $.ui.log(`compaction attempt ${attempt} rejected: ${errorText(err)}`, { to: 'debug' })
    // The person pressing Esc or Ctrl+C cancels compaction; that's a decision, not a hiccup.
    if (isCanceled(errorText(err))) {
      await finish($, runId, `compaction was canceled. ${savedHint(runId, '/relay paste')}`)
      return
    }
    // Rejected because a turn got in first: with nothing in the box, wait for it.
    if (isTurnRunning && filledEarlyRunId !== runId) {
      await deferCompaction($, runId)
      return
    }
    if (isInteractive && attempt < COMPACT_ATTEMPTS && (await isCurrent($, runId))) {
      if (filledEarlyRunId === runId) $.ui.status("compaction is retrying; don't send the prompt yet…")
      timer = $.clock.after(COMPACT_RETRY_MS, () => {
        compact($, runId, attempt + 1).catch(e => finish($, runId, `stopped: ${errorText(e)}`))
      })
      return
    }
    await finish($, runId, `couldn't compact (${errorText(err)}). ${savedHint(runId, 'run /compact yourself, then /relay paste')}`)
    return
  }
  if (result.skip !== undefined) {
    if (compaction?.runId === runId) compaction = null
    await finish($, runId, `compaction was skipped (${result.skip}). ${savedHint(runId, '/relay paste')}`)
    return
  }
  if (compaction?.runId === runId) compaction = { runId, state: 'done' }
  await deliver($, runId)
}

/** Where the continuation prompt is after a failed compaction, and what to do with it. */
function savedHint(runId: number, recovery: string): string {
  return filledEarlyRunId === runId
    ? "The continuation prompt is already in the prompt box: run /compact before you send it, or it runs on the uncompacted conversation."
    : `The continuation prompt is saved: ${recovery}.`
}

/** Fills the box with the run's prompt; false when it can't. */
async function fillSaved($: EngineInterface, run: Run): Promise<boolean> {
  if (!(await isCurrent($, run.runId))) return false
  const text = await promptText($, run)
  return text ? fill($, text).catch(() => false) : false
}

async function deliver($: EngineInterface, runId: number) {
  if (!(await isCurrent($, runId))) return
  const run = await read($, runAtom)
  const text = await promptText($, run)
  if (!text) {
    await finish($, runId, `compacted, but the continuation prompt was lost. Continue from @${run.notePath}.`, { keepHold: true, isCompacted: true })
    // Nobody may be there to send it for the agent's run. The hold ends here, not at the
    // message's turn: if the message were refused, a hold left on would never end.
    if (run.source === 'agent') {
      await submitLater($, `relay compacted this conversation, but its continuation prompt was lost. Read ${run.notePath} and continue from it.`, await release($))
    }
    return
  }
  if (deliverMode(run) === 'submit') {
    // A plugin's submit carries no context, so what was held goes in its text.
    // The hold stays on until this prompt's turn starts, so nothing gets in ahead of it.
    const held = await takeHeld($)
    const body = held.length ? `${forSubmit(text)}\n\n${heldNotice(held)}` : forSubmit(text)
    let refused: string | null = null
    try {
      // By the types, resolves once the prompt entered and its turn started, or was queued; one
      // queued 33 minutes seemed to resolve only at its turn. Nothing here depends on which.
      const r = await $.prompt.submit({ text: body, asUser: true })
      if (r.drop !== undefined) refused = r.drop
    } catch (err) {
      refused = errorText(err)
    }
    if (refused === null) {
      await finish($, runId, null)
      toast($, 'compacted; sending the continuation prompt')
      return
    }
    await finish($, runId, `compacted, but the continuation prompt was refused (${refused}); /relay paste to retry.`, { isCompacted: true })
    if (run.source === 'agent') {
      // Nobody may be there to paste it: point the model at the saved prompt, in other words than the refused ones.
      await submitLater($, `relay compacted this conversation, but its continuation prompt was refused (${refused}). Read ${promptPathFor(run.notePath ?? '')} and continue from it.`, held)
    } else {
      logHeld($, held, refused)
    }
    return
  }
  if (filledEarlyRunId === runId) {
    await finish($, runId, null)
    // Enter during compaction queues the prompt and empties the box.
    const box = (await $.prompt.read().catch(() => ({ text: '' }))).text
    toast($, box.includes(text) ? 'compacted; review the prompt and press Enter' : 'compacted')
    return
  }
  const isFilled = await fill($, text).catch(() => false)
  // A prompt that couldn't be filled is still to be sent, so the hold stays for it.
  await finish($, runId, isFilled ? null : `couldn't fill the prompt box. Continuation prompt:\n\n${text}`, { keepHold: true, isCompacted: true })
  if (isFilled) toast($, 'compacted; review the prompt and press Enter')
}

/** After the handoff's turn: compact and deliver. */
async function continueRun($: EngineInterface, runId: number) {
  if (!(await isCurrent($, runId))) return
  $.ui.status('compacting…')
  await compact($, runId)
}

async function contextTokens($: EngineInterface): Promise<number | null> {
  try {
    const tokens = (await $.session.usage()).context.tokens
    return typeof tokens === 'number' ? tokens : null
  } catch {
    return null
  }
}

async function notePathNow($: EngineInterface, startedAt: number): Promise<string> {
  const noteDir = config.noteDir || `${(await $.env.get('TMPDIR')) || '/tmp'}`.replace(/\/+$/, '') + '/claude-relay'
  return notePathFor(noteDir, await $.session.root(), startedAt)
}

/**
 * The handoff tool was called in the main conversation: save the note and the
 * continuation prompt, and arm the run to compact when this turn ends. In a
 * /relay run this is the save turn's call; with no run, the agent's own
 * start. Returns what the model reads.
 */
async function arm($: EngineInterface, handoff: Handoff): Promise<string> {
  let run = await read($, runAtom)
  if (run.phase === 'armed' || run.phase === 'continuing') return ALREADY_TEXT
  if (run.phase === 'idle') {
    if (run.isBlocked) return CANCELLED_TEXT
    const tokens = await contextTokens($)
    if (tokens !== null && tokens < config.minTokens) return belowMinText(tokens, config.minTokens)
    const startedAt = await $.clock.now()
    const notePath = await notePathNow($, startedAt)
    run = await update($, runAtom, cur =>
      // Checked again here: the person's prompt may have blocked this turn while the size was read.
      cur.phase === 'idle' && !cur.isBlocked
        ? { ...IDLE, phase: 'saving' as const, runId: cur.runId + 1, startedAt, notePath, source: 'agent' as const }
        : cur,
    )
    if (run.isBlocked) return CANCELLED_TEXT
    if (run.phase !== 'saving' || run.source !== 'agent') return ALREADY_TEXT
  }
  const { runId, notePath, startedAt, source } = run
  if (notePath === null || startedAt === null) return UNSAVED_TEXT
  const sessionId = await $.session.id()
  try {
    await $.fs.write(notePath, `${withSession(handoff.note, sessionId)}\n`)
  } catch (err) {
    await finish($, runId, `stopped: couldn't write the handoff note to ${notePath} (${errorText(err)}). Nothing was compacted.`, { tell: 'none' })
    return `${UNSAVED_TEXT} (${errorText(err)})`
  }
  runHandoff = { runId, handoff: { continuation: handoff.continuation, files: handoff.files } }
  const text = composeContinuation(handoff, notePath)
  const saved: SavedPrompt = { text, at: await $.clock.now(), sessionId }
  await $.store.set('lastPrompt', saved).catch(() => undefined)
  // Kept beside the note: to compare with what was sent, and to deliver from after a reload.
  await $.fs.write(promptPathFor(notePath), `${text}\n`).catch(() => undefined)
  // The agent's own run mustn't replace what the person has on the clipboard.
  if (source === 'person' && config.copyToClipboard) await $.ui.copy({ text }).catch(() => undefined)
  const armed = await update($, runAtom, cur =>
    cur.runId === runId && cur.phase === 'saving' ? { ...cur, phase: 'armed' as const } : cur,
  )
  // A cancel got in while the files were written.
  if (armed.runId !== runId || armed.phase !== 'armed') return UNSAVED_TEXT
  await recordRun($, { phase: 'armed', notePath, startedAt, source })
  // From here on, a delivery that would start a turn of its own waits for the continuation prompt.
  await update($, holdAtom, cur => ({ ...cur, isHolding: true, endsAtTurn: false, notice: null, gen: (cur.gen ?? 0) + 1 }))
  const now = await read($, runAtom)
  if (now.runId !== runId || now.phase !== 'armed') {
    // A cancel or the person's prompt ended the run while the record and the hold were written.
    await releaseToSession($)
    return CANCELLED_TEXT
  }
  $.ui.status('handoff saved; compacting when this turn ends…')
  return acceptedText(notePath, deliverMode(armed))
}

/** Submits the save prompt; called from a timer, since command.run can't submit. */
async function submitSave($: EngineInterface, runId: number, save: string) {
  const run = await read($, runAtom)
  if (run.runId !== runId || run.phase !== 'saving') return
  // Anything still held from an earlier run goes to this save turn. Taken only
  // now, so a cancel before this timer runs releases it with the rest.
  const carried = await release($)
  const text = carried.length ? `${save}\n\n${heldNotice(carried)}` : save
  let r
  try {
    r = await $.prompt.submit({ text, asUser: true })
  } catch (err) {
    logHeld($, carried, errorText(err))
    throw err
  }
  if (r.drop !== undefined) {
    await finish($, runId, `stopped: the save prompt was dropped (${r.drop}).`, { tell: 'none' })
    logHeld($, carried, 'the save prompt carrying them was dropped')
    return
  }
  // The submit resolves as the save turn starts. If turn.start didn't match the
  // marker (another plugin rewrote the prompt), don't wait in `saving` forever.
  $.clock.after(SAVE_TURN_WATCHDOG_MS, () => {
    void read($, runAtom)
      .then(cur => {
        if (cur.runId === runId && cur.phase === 'saving' && cur.saveTurnId === null) {
          return finish($, runId, "stopped: couldn't find the save turn. Nothing was compacted; /relay to retry.")
        }
      })
      .catch(() => undefined)
  })
}

/**
 * Registration never throws out of session.start: the engine refuses a name
 * it reserves as a built-in, and refuses every register when no session is
 * bound, and an uncaught throw there skips the rest of the hook. Headless
 * sessions (`claude -p`, the SDK) have no prompt to type a command at, so the
 * command is skipped there. Each failure is one debug-log line (the engine
 * prefixes the plugin name).
 */
async function registerCommand($: EngineInterface, isInteractive: boolean, spec: CommandSpec): Promise<boolean> {
  if (!isInteractive) {
    startupLog($, `/${spec.name} not registered: headless session`)
    return false
  }
  try {
    await $.command.register(spec)
    return true
  } catch (err) {
    startupLog($, `/${spec.name} not registered: ${errorText(err)}`)
    return false
  }
}

/** The handoff tool works headless too, so it is always tried. */
async function registerTool($: EngineInterface): Promise<boolean> {
  try {
    // In the tool list, not behind ToolSearch: an agent has to see when to call it to call it unasked.
    await $.tool.register({ name: TOOL_NAME, description: TOOL_DESCRIPTION, inputSchema: TOOL_SCHEMA, isDeferred: false })
    return true
  } catch (err) {
    startupLog($, `tool ${TOOL_NAME} not registered: ${errorText(err)}`)
    return false
  }
}

function startupLog($: EngineInterface, text: string) {
  try {
    $.ui.log(text)
  } catch {
    // reporting is best effort
  }
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  timer = null
  isTurnRunning = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    isInteractive = e.isInteractive
    await registerTool($)
    await registerCommand($, e.isInteractive, {
      name: 'relay',
      description: 'Save state to durable notes and a handoff note, compact, and queue a continuation prompt',
      argumentHint: '[focus | status | cancel | paste]',
    })
    // A `saving` or `armed` run holds no timer, so its next event can still carry it on.
    const run = await read($, runAtom)
    if (run.phase === 'continuing') {
      await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
      await forgetRun($)
      if (run.notePath !== null && run.startedAt !== null) {
        const notice = lostRunNotice({ phase: 'continuing', notePath: run.notePath, startedAt: run.startedAt, source: run.source }, 'reload')
        $.ui.log(notice)
        await handBack($, notice, run.source === 'agent')
      }
    } else if (run.phase === 'idle') {
      await reportLostRun($)
      await restoreLostHeld($)
    }
    await pruneRuns($)
    return result
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // Only the main conversation is compacted; a subagent's or teammate's call changes nothing.
    if (e.agentId !== undefined) return { result: SUBAGENT_TEXT }
    const handoff = parseHandoff(e as unknown as Record<string, unknown>)
    if ('error' in handoff) return { result: handoff.error }
    return { result: await arm($, handoff) }
  }).catch(() => ({ result: UNSAVED_TEXT }))

  on('turn.start', async ($, e, next) => {
    // Subagents' and teammates' turns raise turn.start too (2.1.312; not 2.1.294); only the main loop's count.
    if (e.agentId !== undefined) return next(e)
    isTurnRunning = true
    // The person's prompt took what was held at Enter; anything since follows its turn.
    if ((await read($, holdAtom)).endsAtTurn) await releaseToSession($)
    const run = await read($, runAtom)
    // Latched: a turn that ends before a compaction retry still counts.
    if (run.phase === 'continuing' && filledEarlyRunId === run.runId) sentEarlyRunId = run.runId
    // A handoff call is refused in a turn whose /relay was stopped, and in a save turn with no run behind it.
    const isBlocked = e.text.includes(SAVE_MARKER) && !(run.phase === 'saving' && run.source === 'person' && run.saveTurnId === null)
    if (run.isBlocked !== isBlocked) await update($, runAtom, cur => ({ ...cur, isBlocked }))
    // A turn before the compaction was asked for ran on the uncompacted conversation, after the note.
    if (run.phase === 'continuing' && compaction?.runId !== run.runId) {
      await update($, runAtom, cur => (cur.runId === run.runId ? { ...cur, isStale: true } : cur))
    }
    if (run.phase === 'saving' && run.source === 'person' && run.saveTurnId === null && e.text.includes(SAVE_MARKER)) {
      await update($, runAtom, cur => (cur.runId === run.runId ? { ...cur, saveTurnId: e.turnId } : cur))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnRunning = false
    const run = await read($, runAtom)
    if (run.phase === 'saving' && run.saveTurnId !== null && run.saveTurnId === e.turnId) {
      await finish($, run.runId, `stopped: the save turn ended (${e.reason}) without calling the ${TOOL} tool. Nothing was saved or compacted; /relay to retry.`)
      return result
    }
    if (run.phase === 'armed') {
      if (e.reason !== 'answer') {
        await finish($, run.runId, `stopped: the turn ended (${e.reason}) before the compaction. Nothing was compacted.`)
        return result
      }
      const now = await update($, runAtom, cur =>
        cur.runId === run.runId && cur.phase === 'armed' ? { ...cur, phase: 'continuing' as const } : cur,
      )
      if (now.runId !== run.runId || now.phase !== 'continuing' || now.notePath === null || now.startedAt === null) return result
      await recordRun($, { phase: 'continuing', notePath: now.notePath, startedAt: now.startedAt, source: now.source })
      // Compaction rejects while a turn runs, so continue once this one has ended.
      await soon($, run.runId, () => continueRun($, run.runId))
      return result
    }
    if (run.phase === 'continuing' && waitingRunId === run.runId) {
      // The turn the compaction waited for has ended.
      waitingRunId = null
      if (e.reason !== 'answer') {
        await finish($, run.runId, `stopped: the turn that started before the compaction ended (${e.reason}). Nothing was compacted.`)
        return result
      }
      await soon($, run.runId, () => continueRun($, run.runId))
    }
    return result
  })

  // A teammate's message raises no prompt.submit: it arrives here, and starts a
  // turn once the session is idle even when it came in while a turn ran. So it
  // is held whenever the hold is on, and named, since the text arrives bare.
  on('session.receive', async ($, e, next) => {
    if (e.agentId !== undefined || !('teammate' in e.origin)) return next(e)
    if (!(await read($, holdAtom)).isHolding) return next(e)
    const item = teammateItem(e.origin.teammate, e.text)
    let isCaptured = false
    await update($, holdAtom, cur => {
      const held = holdAppend(cur, item)
      isCaptured = held !== null
      return held ?? cur
    })
    if (isCaptured) {
      await saveHeld($)
      return { consumed: 'relay is holding this until the continuation prompt, which carries it' }
    }
    return next(e)
  }).catch(($, e, next) => next(e)) // a failure lets the message through; holding is best effort

  on('prompt.submit', async ($, e, next) => {
    const hold = await read($, holdAtom)
    const run = await read($, runAtom)
    // One delivered into a running turn starts no turn of its own. One stamped
    // with a turn that has since ended would, so it is held like the rest.
    if (hold.isHolding && isHeldOrigin(e.origin.kind) && (e.turnId === undefined || !isTurnRunning)) {
      let isCaptured = false
      await update($, holdAtom, cur => {
        const held = holdAppend(cur, e.text)
        isCaptured = held !== null
        return held ?? cur
      })
      if (isCaptured) {
        await saveHeld($)
        return { drop: 'relay is holding this until you send the continuation prompt; it goes along with that prompt.' }
      }
      return next(e)
    }
    if (!isPersonOrigin(e.origin.kind)) return next(e)
    if (run.phase === 'idle') {
      // Typed over a running turn, it runs next: a handoff the agent starts later
      // in this turn would compact over it and then send a continuation after it.
      if (e.turnId !== undefined && !run.isBlocked) await update($, runAtom, cur => ({ ...cur, isBlocked: true }))
      if (!hold.isHolding && !hold.notice) return next(e)
    }
    // The person's prompt got in before the compaction: it is theirs to run
    // now, so the run stops, and this prompt tells the model. Once the
    // compaction is in flight or done it is queued behind it; with the prompt
    // already in the box it is taken for the continuation.
    const isAhead = run.phase === 'saving' || run.phase === 'armed' || (run.phase === 'continuing' && compaction?.runId !== run.runId && filledEarlyRunId !== run.runId)
    if (isAhead) {
      await finish(
        $,
        run.runId,
        "stopped: your prompt arrived before the compaction, so nothing was compacted. /relay again when you're ready.",
        { keepHold: true, tell: 'notice', block: true },
      )
    }
    let taken: string[] = []
    let notice: string | null = null
    let gen = 0
    let didEnd = false
    await update($, holdAtom, cur => {
      gen = cur.gen ?? 0
      didEnd = cur.isHolding && !cur.endsAtTurn
      taken = didEnd ? cur.items : []
      notice = cur.notice ?? null
      return { ...cur, items: didEnd ? [] : cur.items, endsAtTurn: cur.isHolding ? true : cur.endsAtTurn, notice: null }
    })
    const extra = [...(notice ? [notice] : []), ...(taken.length ? [heldNotice(taken)] : [])]
    const result = await next(extra.length ? { ...e, context: [...(e.context ?? []), ...extra] } : e)
    if (result.drop !== undefined) {
      // Refused further down: give back what it took, unless the hold has ended since.
      let isRestored = false
      await update($, holdAtom, cur => {
        const back = restoreHold(cur, taken, gen, didEnd, notice)
        isRestored = back !== null
        return back ?? cur
      })
      if (!isRestored) logHeld($, taken, 'the prompt carrying them was refused after the hold ended')
    }
    return result
  }).catch(($, e, next) => next(e)) // a failure lets the prompt through; holding is best effort

  on('command.run', { command: 'relay' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    const run = await read($, runAtom)

    switch (cmd.kind) {
      case 'status': {
        const hold = await read($, holdAtom)
        const holding = hold.isHolding
          ? ` Holding ${hold.items.length} background message${hold.items.length === 1 ? '' : 's'} until your next prompt; /relay cancel releases them.`
          : ''
        if (run.phase === 'idle') return { text: `Idle.${holding}` }
        const minutes = run.startedAt === null ? 0 : Math.round(((await $.clock.now()) - run.startedAt) / 60_000)
        const phase = { saving: 'Saving', armed: 'Handoff saved; compacting when the turn ends', continuing: 'Compacting' }[run.phase]
        return { text: `${phase}, started ${minutes} min ago. /relay cancel to stop.${holding}` }
      }

      case 'cancel': {
        const hold = await read($, holdAtom)
        if (run.phase === 'idle' && !hold.isHolding) return { text: 'Nothing to cancel.' }
        if (run.phase !== 'idle') {
          cancelTimer()
          waitingRunId = null
          await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1, isBlocked: true }))
          await forgetRun($)
          $.ui.status(undefined)
          logRunDone($, run, 'cancelled')
        }
        // The model was told a compaction was coming; the person's next prompt corrects that, or the
        // hand-back's own turn. Once the compaction was asked for, relay can't say whether it went through.
        const notice = run.phase !== 'idle' && compaction?.runId !== run.runId ? notCompactedNotice('The person cancelled it.', run.notePath) : null
        const released = await handBack($, notice, false)
        const note = released ? ` Released ${released} held message${released === 1 ? '' : 's'}.` : ''
        return { text: `Cancelled. Anything already saved or compacted stays.${note}` }
      }

      case 'paste': {
        const saved = (await $.store.get('lastPrompt')) as SavedPrompt | undefined
        if (!saved?.text) return { text: 'No saved continuation prompt.' }
        const isFilled = await fill($, saved.text).catch(() => false)
        const when = new Date(saved.at).toISOString()
        return {
          text: isFilled
            ? `Filled the continuation prompt saved ${when} (session ${saved.sessionId}).`
            : `Couldn't fill the prompt box. Saved ${when} (session ${saved.sessionId}):\n\n${saved.text}`,
        }
      }

      case 'start': {
        if (run.phase !== 'idle') return { text: `Already ${run.phase}. /relay status, or /relay cancel to reset.` }
        if ((await $.session.turns()) === 0) return { text: 'Nothing to hand off yet.' }
        const runId = run.runId + 1
        const startedAt = await $.clock.now()
        const notePath = await notePathNow($, startedAt)
        await update($, runAtom, cur => ({ ...IDLE, phase: 'saving' as const, runId, startedAt, notePath, isBlocked: cur.isBlocked }))
        await recordRun($, { phase: 'saving', notePath, startedAt, source: 'person' })
        $.ui.status('saving state…')
        // The host refuses a submit from inside command.run (it would wait on
        // the turn this hook holds), so submit once the command has returned.
        const save = savePrompt(cmd.focus, config.saveInstructions)
        cancelTimer()
        timer = $.clock.after(0, () => {
          submitSave($, runId, save).catch(err =>
            finish($, runId, `stopped: couldn't submit the save prompt (${errorText(err)}).`, { tell: 'none' }),
          )
        })
        return { text: 'Saving state, then handing off: a note, a compaction and a continuation prompt.' }
      }
    }
  })
}
