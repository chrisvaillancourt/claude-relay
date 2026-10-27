import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import {
  cleanContinuation,
  continuationPrompt,
  extractNote,
  forSubmit,
  heldNotice,
  holdAppend,
  restoreHold,
  isCanceled,
  isHeldOrigin,
  isPersonOrigin,
  isRunRecord,
  notePathFor,
  parseArgs,
  promptPathFor,
  restartNotice,
  resumedNoteNotice,
  RUN_KEY_PREFIX,
  runKey,
  SAVE_MARKER,
  savePrompt,
  taggedNote,
} from './prompts'
import type { Config, Hold, Run, RunRecord, SavedPrompt } from '../types'

/** A compaction right after the save turn may still see it running; retry briefly, then give up. */
const COMPACT_RETRY_MS = 2000
const COMPACT_ATTEMPTS = 3
/** How long after the save prompt's turn started to expect its turn.start to have been matched. */
const SAVE_TURN_WATCHDOG_MS = 5000
/** Run records older than this, from sessions never resumed, are dropped at session start. */
const RUN_RECORD_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_COMPACT_INSTRUCTIONS =
  "Keep any information that's helpful to the agent and not written to a durable location."

const IDLE: Run = { phase: 'idle', runId: 0, saveTurnId: null, startedAt: null, notePath: null }

const runAtom = atom({ plugin: 'relay', key: 'run' } as const, IDLE)

const RELEASED: Hold = { isHolding: false, items: [], endsAtTurn: false, gen: 0 }
const holdAtom = atom({ plugin: 'relay', key: 'hold' } as const, RELEASED)

// Module variables reset on a hot reload; `$.state` survives one. A run left
// `continuing` by a reload has lost its timer, so session.start resets it.
let config: Config = configFrom({})
let timer: Timer | null = null
/** The run whose continuation prompt went into the box as compaction started. */
let filledEarlyRunId: number | null = null
/** The run a main-loop turn started in after its save turn, even one that has ended since. */
let interruptedRunId: number | null = null
let isInteractive = true
/** Whether a main-loop turn is running; subagents raise no turn.start. */
let isTurnRunning = false
/** A save turn whose run a restart lost: the first main-loop turn to end may be its resumption. */
let lostSaveTurn: RunRecord | null = null

function configFrom(options: PluginOptions): Config {
  const instructions = typeof options.compactInstructions === 'string' ? options.compactInstructions.trim() : ''
  return {
    deliver: options.deliver === 'submit' ? 'submit' : 'fill',
    compactInstructions: instructions || DEFAULT_COMPACT_INSTRUCTIONS,
    copyToClipboard: options.copyToClipboard !== false,
    noteDir: typeof options.noteDir === 'string' ? options.noteDir.trim() : '',
    saveInstructions: typeof options.saveInstructions === 'string' ? options.saveInstructions.trim() : '',
    fillDuringCompaction: options.fillDuringCompaction !== false,
  }
}

/** Ends the hold and returns what it held. */
async function release($: EngineInterface): Promise<string[]> {
  let items: string[] = []
  await update($, holdAtom, cur => {
    items = cur.items
    return { ...RELEASED, gen: (cur.gen ?? 0) + 1 }
  })
  return items
}

/** Puts held messages that couldn't be handed back in the transcript, so they aren't lost. */
function logHeld($: EngineInterface, items: readonly string[], why: string) {
  if (!items.length) return
  try {
    $.ui.log(`relay: couldn't hand back ${items.length} held message${items.length === 1 ? '' : 's'} (${why}). Here they are:\n\n${heldNotice(items)}`)
  } catch {
    // Best effort.
  }
}

/**
 * Ends the hold and hands what it held back to the session as relay's own
 * message, which runs once the session is idle. From a timer, since a hook
 * that submits would wait on itself.
 */
async function releaseToSession($: EngineInterface): Promise<number> {
  const held = await release($)
  if (held.length) {
    $.clock.after(0, () => {
      $.prompt
        .submit({ text: heldNotice(held) })
        .then(r => {
          if (r.drop !== undefined) logHeld($, held, r.drop)
        })
        .catch(err => logHeld($, held, errorText(err)))
    })
  }
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
 * host, a crash and resume), and its timers with it: say so instead of going quiet.
 */
async function reportLostRun($: EngineInterface) {
  try {
    const record = await $.store.get(runKey(await $.session.id()))
    if (record === undefined) return
    await forgetRun($)
    if (!isRunRecord(record)) return
    if (record.phase === 'saving') lostSaveTurn = record
    $.ui.log(`relay: ${restartNotice(record)}`)
    toast($, 'a restart interrupted /relay; nothing was compacted')
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

/** The resumed save turn of a lost run ended: keep its note, since nothing else will. */
async function saveLostNote($: EngineInterface, record: RunRecord, answer: string) {
  const note = taggedNote(answer)
  if (!note) return
  try {
    await $.fs.write(record.notePath, `${note}\n`)
    $.ui.log(`relay: ${resumedNoteNotice(record.notePath)}`)
  } catch (err) {
    $.ui.log(`relay: couldn't save the resumed turn's handoff note to ${record.notePath} (${errorText(err)}); it's in the turn above. Nothing was compacted.`)
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

/** Ends run `runId` if it is still the live one, and says why; never throws. */
async function finish($: EngineInterface, runId: number, message: string | null, keepHold = false) {
  try {
    const run = await read($, runAtom)
    if (run.runId !== runId || run.phase === 'idle') return
    await update($, runAtom, cur => (cur.runId === runId ? { ...IDLE, runId } : cur))
    await forgetRun($)
    $.ui.status(undefined)
    if (message) $.ui.log(`relay: ${message}`)
    // A failure leaves no continuation prompt to wait for, unless it's already in the box.
    if (message && !keepHold && filledEarlyRunId !== runId) await releaseToSession($)
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

/** Compacts, retrying briefly if the save turn hasn't finished tearing down. */
async function compact($: EngineInterface, runId: number, attempt = 1): Promise<void> {
  if (!(await isCurrent($, runId))) return
  if (isTurnRunning || interruptedRunId === runId) {
    await finish(
      $,
      runId,
      filledEarlyRunId === runId
        ? 'stopped: a turn started while compaction was retrying. If it was the continuation prompt, it ran on the uncompacted conversation; /compact, then /relay paste, to start over.'
        : 'stopped: a new turn started before compaction. The continuation prompt is saved: /compact, then /relay paste.',
    )
    return
  }
  let result
  try {
    const compacting = $.session.compact({ instructions: config.compactInstructions })
    if (attempt === 1 && config.deliver === 'fill' && config.fillDuringCompaction) {
      // The prompt goes in as compaction starts, so the person can queue it
      // before a background task finishes. Its rejection is awaited below.
      compacting.catch(() => undefined)
      if (await fillSaved($, runId)) {
        filledEarlyRunId = runId
        $.ui.status('compacting… the continuation prompt is in the box; Enter queues it')
      }
    }
    result = await compacting
  } catch (err) {
    $.ui.log(`relay: compaction attempt ${attempt} rejected: ${errorText(err)}`, { to: 'debug' })
    // The person pressing Esc or Ctrl+C cancels compaction; that's a decision, not a hiccup.
    if (isCanceled(errorText(err))) {
      await finish($, runId, `compaction was canceled. ${savedHint(runId, '/relay paste')}`)
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
    await finish($, runId, `compaction was skipped (${result.skip}). ${savedHint(runId, '/relay paste')}`)
    return
  }
  await deliver($, runId)
}

/** Where the continuation prompt is after a failed compaction, and what to do with it. */
function savedHint(runId: number, recovery: string): string {
  return filledEarlyRunId === runId
    ? "The continuation prompt is already in the prompt box: run /compact before you send it, or it runs on the uncompacted conversation."
    : `The continuation prompt is saved: ${recovery}.`
}

/** Fills the box with the run's saved prompt; false when it can't. */
async function fillSaved($: EngineInterface, runId: number): Promise<boolean> {
  if (!(await isCurrent($, runId))) return false
  const saved = (await $.store.get('lastPrompt')) as SavedPrompt | undefined
  return saved?.text ? fill($, saved.text).catch(() => false) : false
}

async function deliver($: EngineInterface, runId: number) {
  if (!(await isCurrent($, runId))) return
  const saved = (await $.store.get('lastPrompt')) as SavedPrompt | undefined
  const text = saved?.text ?? ''
  if (config.deliver === 'submit') {
    await finish($, runId, null)
    // A plugin's submit carries no context, so what was held goes in its text.
    const held = await release($)
    const body = held.length ? `${forSubmit(text)}\n\n${heldNotice(held)}` : forSubmit(text)
    void $.prompt
      .submit({ text: body, asUser: true })
      .then(async r => {
        if (r.drop === undefined) return
        $.ui.log(`relay: the continuation prompt was dropped (${r.drop}); /relay paste to retry.`)
        logHeld($, held, r.drop)
      })
      .catch(err => {
        $.ui.log(`relay: couldn't submit the continuation prompt (${errorText(err)}); /relay paste to retry.`)
        logHeld($, held, errorText(err))
      })
    toast($, 'compacted; sending the continuation prompt')
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
  await finish($, runId, isFilled ? null : `couldn't fill the prompt box. Continuation prompt:\n\n${text}`, true)
  if (isFilled) toast($, 'compacted; review the prompt and press Enter')
}

/** After the save turn: write its note, fork the continuation prompt, keep it, then compact and deliver. */
async function continueRun($: EngineInterface, runId: number, answer: string, notePath: string) {
  const note = extractNote(answer)
  try {
    if (!(await isCurrent($, runId))) return
    if (!note) {
      await finish($, runId, 'stopped: the save turn ended with no handoff note. Nothing was compacted.')
      return
    }
    try {
      await $.fs.write(notePath, `${note}\n`)
    } catch (err) {
      await finish($, runId, `stopped: couldn't write the handoff note to ${notePath} (${errorText(err)}). Nothing was compacted.`)
      return
    }
    const startedAt = (await read($, runAtom)).startedAt
    if (startedAt !== null) await recordRun($, { phase: 'continuing', notePath, startedAt })
    $.ui.status('writing the continuation prompt…')
    // The fork replays the last request, which ends before the note, so the note rides along.
    const reply = await $.model.fork({ prompt: continuationPrompt(note, notePath) })
    if (!(await isCurrent($, runId))) return
    if (!reply.isAnswered) {
      await finish($, runId, `stopped: the continuation prompt failed (${reply.reason}). Nothing was compacted.`)
      return
    }
    const text = cleanContinuation(reply.text)
    if (!text) {
      await finish($, runId, 'stopped: the continuation prompt came back empty. Nothing was compacted.')
      return
    }
    const saved: SavedPrompt = { text, at: await $.clock.now(), sessionId: await $.session.id() }
    await $.store.set('lastPrompt', saved)
    // Kept beside the note, to compare with what the person sends; best effort.
    await $.fs.write(promptPathFor(notePath), `${text}\n`).catch(() => undefined)
    if (config.copyToClipboard) await $.ui.copy({ text }).catch(() => undefined)
    if (!(await isCurrent($, runId))) return
    $.ui.status('compacting…')
    await compact($, runId)
  } catch (err) {
    await finish($, runId, `stopped: ${errorText(err)}`)
  }
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
    await finish($, runId, `stopped: the save prompt was dropped (${r.drop}).`)
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

export const register: Register = (on, options) => {
  config = configFrom(options)
  timer = null
  isTurnRunning = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    isInteractive = e.isInteractive
    await $.command.register({
      name: 'relay',
      description: 'Save state to durable notes, draft a continuation prompt, compact, and queue the prompt',
      argumentHint: '[focus | status | cancel | paste]',
    })
    // A `saving` run holds no timer, so its turn.complete can still continue it.
    const run = await read($, runAtom)
    if (run.phase === 'continuing') {
      await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
      await forgetRun($)
      $.ui.log(
        'relay: a reload interrupted the run after the save turn. If a continuation prompt was drafted, /relay paste has it; run /compact yourself first.',
      )
    } else if (run.phase === 'idle') {
      await reportLostRun($)
    }
    await pruneRuns($)
    return result
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    // The person's prompt took what was held at Enter; anything since follows its turn.
    if ((await read($, holdAtom)).endsAtTurn) await releaseToSession($)
    const run = await read($, runAtom)
    // Latched: a turn that ends before a compaction retry still counts.
    if (run.phase === 'continuing') interruptedRunId = run.runId
    if (run.phase === 'saving' && run.saveTurnId === null && e.text.includes(SAVE_MARKER)) {
      await update($, runAtom, cur => (cur.runId === run.runId ? { ...cur, saveTurnId: e.turnId } : cur))
      // From the save turn on, a delivery that would start a turn of its own waits
      // for the continuation prompt; one into this turn carries its turnId and passes.
      await update($, holdAtom, cur => ({ ...cur, isHolding: true, endsAtTurn: false, gen: (cur.gen ?? 0) + 1 }))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnRunning = false
    const run = await read($, runAtom)
    if (lostSaveTurn) {
      const lost = lostSaveTurn
      lostSaveTurn = null
      if (run.phase === 'idle' && e.reason === 'answer') await saveLostNote($, lost, e.answer)
      return result
    }
    if (run.phase !== 'saving' || run.saveTurnId !== e.turnId) return result
    if (e.reason !== 'answer') {
      await finish($, run.runId, `stopped: the save turn ended (${e.reason}). Nothing was compacted.`)
      return result
    }
    const now = await update($, runAtom, cur =>
      cur.runId === run.runId && cur.phase === 'saving' ? { ...cur, phase: 'continuing' as const } : cur,
    )
    if (now.runId !== run.runId || now.phase !== 'continuing' || now.notePath === null) return result
    const notePath = now.notePath
    // Compaction rejects while a turn runs, so continue once this one has ended.
    cancelTimer()
    timer = $.clock.after(0, () => void continueRun($, run.runId, e.answer, notePath))
    return result
  })

  on('prompt.submit', async ($, e, next) => {
    if (!(await read($, holdAtom)).isHolding) return next(e)
    // One delivered into a running turn starts no turn of its own.
    if (isHeldOrigin(e.origin.kind) && e.turnId === undefined) {
      let isCaptured = false
      await update($, holdAtom, cur => {
        const held = holdAppend(cur, e.text)
        isCaptured = held !== null
        return held ?? cur
      })
      if (isCaptured) return { drop: 'relay is holding this until you send the continuation prompt; it goes along with that prompt.' }
      return next(e)
    }
    if (!isPersonOrigin(e.origin.kind)) return next(e)
    // Typed into the save turn: not the continuation prompt, so the hold goes on.
    if (e.turnId !== undefined && e.turnId === (await read($, runAtom)).saveTurnId) return next(e)
    let taken: string[] = []
    let gen = 0
    let didEnd = false
    await update($, holdAtom, cur => {
      gen = cur.gen ?? 0
      didEnd = !cur.endsAtTurn
      taken = didEnd ? cur.items : []
      return didEnd ? { ...cur, items: [], endsAtTurn: true } : cur
    })
    const result = await next(taken.length ? { ...e, context: [...(e.context ?? []), heldNotice(taken)] } : e)
    if (result.drop !== undefined) {
      // Refused further down: give back what it took, unless the hold has ended since.
      let isRestored = false
      await update($, holdAtom, cur => {
        const back = restoreHold(cur, taken, gen, didEnd)
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
        return { text: `${run.phase === 'saving' ? 'Saving' : 'Continuing'}, started ${minutes} min ago. /relay cancel to stop.${holding}` }
      }

      case 'cancel': {
        const hold = await read($, holdAtom)
        if (run.phase === 'idle' && !hold.isHolding) return { text: 'Nothing to cancel.' }
        if (run.phase !== 'idle') {
          cancelTimer()
          await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
          await forgetRun($)
          $.ui.status(undefined)
        }
        const released = await releaseToSession($)
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
        const noteDir = config.noteDir || `${(await $.env.get('TMPDIR')) || '/tmp'}`.replace(/\/+$/, '') + '/claude-relay'
        const notePath = notePathFor(noteDir, await $.session.root(), startedAt)
        await update($, runAtom, () => ({ phase: 'saving' as const, runId, saveTurnId: null, startedAt, notePath }))
        await recordRun($, { phase: 'saving', notePath, startedAt })
        lostSaveTurn = null
        $.ui.status('saving state…')
        // The host refuses a submit from inside command.run (it would wait on
        // the turn this hook holds), so submit once the command has returned.
        const save = savePrompt(cmd.focus, notePath, config.saveInstructions)
        cancelTimer()
        timer = $.clock.after(0, () => {
          submitSave($, runId, save).catch(err =>
            finish($, runId, `stopped: couldn't submit the save prompt (${errorText(err)}).`),
          )
        })
        return { text: 'Saving state, then drafting a continuation prompt and compacting.' }
      }
    }
  })
}
