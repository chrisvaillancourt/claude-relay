import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import { cleanContinuation, continuationPrompt, forSubmit, parseArgs, SAVE_MARKER, savePrompt } from './prompts'
import type { Config, Run, SavedPrompt } from '../types'

/** A compaction right after the save turn may still see it running; retry briefly, then give up. */
const COMPACT_RETRY_MS = 2000
const COMPACT_ATTEMPTS = 3
/** How long after the save prompt's turn started to expect its turn.start to have been matched. */
const SAVE_TURN_WATCHDOG_MS = 5000
const DEFAULT_COMPACT_INSTRUCTIONS =
  "Keep any information that's helpful to the agent and not written to a durable location."

const IDLE: Run = { phase: 'idle', runId: 0, saveTurnId: null, startedAt: null }

const runAtom = atom({ plugin: 'handoff', key: 'run' } as const, IDLE)

// Module variables reset on a hot reload; `$.state` survives one. A run left
// `continuing` by a reload has lost its timer, so session.start resets it.
let config: Config = configFrom({})
let timer: Timer | null = null
let isInteractive = true
/** Whether a main-loop turn is running; subagents raise no turn.start. */
let isTurnRunning = false

function configFrom(options: PluginOptions): Config {
  const instructions = typeof options.compactInstructions === 'string' ? options.compactInstructions.trim() : ''
  return {
    deliver: options.deliver === 'submit' ? 'submit' : 'fill',
    compactInstructions: instructions || DEFAULT_COMPACT_INSTRUCTIONS,
    copyToClipboard: options.copyToClipboard !== false,
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
async function finish($: EngineInterface, runId: number, message: string | null) {
  try {
    const run = await read($, runAtom)
    if (run.runId !== runId || run.phase === 'idle') return
    await update($, runAtom, cur => (cur.runId === runId ? { ...IDLE, runId } : cur))
    $.ui.status(undefined)
    if (message) $.ui.log(`handoff: ${message}`)
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
  if (isTurnRunning) {
    await finish(
      $,
      runId,
      'stopped: a new turn started before compaction. The continuation prompt is saved: /compact, then /handoff paste.',
    )
    return
  }
  let result
  try {
    result = await $.session.compact({ instructions: config.compactInstructions })
  } catch (err) {
    $.ui.log(`handoff: compaction attempt ${attempt} rejected: ${errorText(err)}`, { to: 'debug' })
    if (isInteractive && attempt < COMPACT_ATTEMPTS && (await isCurrent($, runId))) {
      timer = $.clock.after(COMPACT_RETRY_MS, () => {
        compact($, runId, attempt + 1).catch(e => finish($, runId, `stopped: ${errorText(e)}`))
      })
      return
    }
    await finish(
      $,
      runId,
      `couldn't compact (${errorText(err)}). The continuation prompt is saved: run /compact yourself, then /handoff paste.`,
    )
    return
  }
  if (result.skip !== undefined) {
    await finish($, runId, `compaction was skipped (${result.skip}). The continuation prompt is saved: /handoff paste.`)
    return
  }
  await deliver($, runId)
}

async function deliver($: EngineInterface, runId: number) {
  if (!(await isCurrent($, runId))) return
  const saved = (await $.store.get('lastPrompt')) as SavedPrompt | undefined
  const text = saved?.text ?? ''
  if (config.deliver === 'submit') {
    await finish($, runId, null)
    void $.prompt
      .submit({ text: forSubmit(text), asUser: true })
      .then(r => {
        if (r.drop !== undefined) $.ui.log(`handoff: the continuation prompt was dropped (${r.drop}); /handoff paste to retry.`)
      })
      .catch(err => $.ui.log(`handoff: couldn't submit the continuation prompt (${errorText(err)}); /handoff paste to retry.`))
    toast($, 'compacted; sending the continuation prompt')
    return
  }
  const isFilled = await fill($, text).catch(() => false)
  await finish($, runId, isFilled ? null : `couldn't fill the prompt box. Continuation prompt:\n\n${text}`)
  if (isFilled) toast($, 'compacted; review the prompt and press Enter')
}

/** After the save turn: fork the continuation prompt, keep it, then compact and deliver. */
async function continueRun($: EngineInterface, runId: number, answer: string) {
  try {
    if (!(await isCurrent($, runId))) return
    $.ui.status('writing the continuation prompt…')
    // The fork replays the last request, which ends before the save turn's final answer.
    const reply = await $.model.fork({ prompt: continuationPrompt(answer) })
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
    if (config.copyToClipboard) await $.ui.copy({ text }).catch(() => undefined)
    if (!(await isCurrent($, runId))) return
    $.ui.status('compacting…')
    await compact($, runId)
  } catch (err) {
    await finish($, runId, `stopped: ${errorText(err)}`)
  }
}

/** Submits the save prompt; called from a timer, since command.run can't submit. */
async function submitSave($: EngineInterface, runId: number, text: string) {
  const run = await read($, runAtom)
  if (run.runId !== runId || run.phase !== 'saving') return
  const r = await $.prompt.submit({ text, asUser: true })
  if (r.drop !== undefined) {
    await finish($, runId, `stopped: the save prompt was dropped (${r.drop}).`)
    return
  }
  // The submit resolves as the save turn starts. If turn.start didn't match the
  // marker (another plugin rewrote the prompt), don't wait in `saving` forever.
  $.clock.after(SAVE_TURN_WATCHDOG_MS, () => {
    void read($, runAtom)
      .then(cur => {
        if (cur.runId === runId && cur.phase === 'saving' && cur.saveTurnId === null) {
          return finish($, runId, "stopped: couldn't find the save turn. Nothing was compacted; /handoff to retry.")
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
      name: 'handoff',
      description: 'Save state to durable notes, draft a continuation prompt, compact, and queue the prompt',
      argumentHint: '[focus | status | cancel | paste]',
    })
    // A `saving` run holds no timer, so its turn.complete can still continue it.
    const run = await read($, runAtom)
    if (run.phase === 'continuing') {
      await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
      $.ui.log(
        'handoff: a reload interrupted the run after the save turn. If a continuation prompt was drafted, /handoff paste has it; run /compact yourself first.',
      )
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    const run = await read($, runAtom)
    if (run.phase === 'saving' && run.saveTurnId === null && e.text.includes(SAVE_MARKER)) {
      await update($, runAtom, cur => (cur.runId === run.runId ? { ...cur, saveTurnId: e.turnId } : cur))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    isTurnRunning = false
    const run = await read($, runAtom)
    if (run.phase !== 'saving' || run.saveTurnId !== e.turnId) return result
    if (e.reason !== 'answer') {
      await finish($, run.runId, `stopped: the save turn ended (${e.reason}). Nothing was compacted.`)
      return result
    }
    const now = await update($, runAtom, cur =>
      cur.runId === run.runId && cur.phase === 'saving' ? { ...cur, phase: 'continuing' as const } : cur,
    )
    if (now.runId !== run.runId || now.phase !== 'continuing') return result
    // Compaction rejects while a turn runs, so continue once this one has ended.
    cancelTimer()
    timer = $.clock.after(0, () => void continueRun($, run.runId, e.answer))
    return result
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    const run = await read($, runAtom)

    switch (cmd.kind) {
      case 'status': {
        if (run.phase === 'idle') return { text: 'Idle.' }
        const minutes = run.startedAt === null ? 0 : Math.round(((await $.clock.now()) - run.startedAt) / 60_000)
        return { text: `${run.phase === 'saving' ? 'Saving' : 'Continuing'}, started ${minutes} min ago. /handoff cancel to stop.` }
      }

      case 'cancel': {
        if (run.phase === 'idle') return { text: 'Nothing to cancel.' }
        cancelTimer()
        await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
        $.ui.status(undefined)
        return { text: 'Cancelled. Anything already saved or compacted stays.' }
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
        if (run.phase !== 'idle') return { text: `Already ${run.phase}. /handoff status, or /handoff cancel to reset.` }
        if ((await $.session.turns()) === 0) return { text: 'Nothing to hand off yet.' }
        const runId = run.runId + 1
        const startedAt = await $.clock.now()
        await update($, runAtom, () => ({ phase: 'saving' as const, runId, saveTurnId: null, startedAt }))
        $.ui.status('saving state…')
        // The host refuses a submit from inside command.run (it would wait on
        // the turn this hook holds), so submit once the command has returned.
        const text = savePrompt(cmd.focus)
        cancelTimer()
        timer = $.clock.after(0, () => {
          submitSave($, runId, text).catch(err =>
            finish($, runId, `stopped: couldn't submit the save prompt (${errorText(err)}).`),
          )
        })
        return { text: 'Saving state, then drafting a continuation prompt and compacting.' }
      }
    }
  })
}
