import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, Timer } from 'claude-code'

import { cleanContinuation, CONTINUATION_PROMPT, forSubmit, parseArgs, SAVE_MARKER, savePrompt } from './prompts'
import type { Config, Run, SavedPrompt } from '../types'

const COMPACT_RETRY_MS = 2000
const COMPACT_ATTEMPTS = 30
const DEFAULT_COMPACT_INSTRUCTIONS =
  "Keep any information that's helpful to the agent and not written to a durable location."

const IDLE: Run = { phase: 'idle', runId: 0, saveTurnId: null, startedAt: null }

const runAtom = atom({ plugin: 'handoff', key: 'run' } as const, IDLE)

// Module variables reset on a hot reload; `$.state` survives one. A run left
// mid-flight by a reload has lost its timer, so session.start resets it.
let config: Config = configFrom({})
let timer: Timer | null = null

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

/** Ends the run (if it's still `runId`) and says why; never throws. */
async function finish($: EngineInterface, runId: number, message: string | null) {
  try {
    const run = await read($, runAtom)
    if (run.runId !== runId) return
    await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId }))
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

async function savePromptToStore($: EngineInterface, text: string) {
  const saved: SavedPrompt = { text, at: await $.clock.now(), sessionId: await $.session.id() }
  await $.store.set('lastPrompt', saved)
}

async function fill($: EngineInterface, text: string): Promise<boolean> {
  const filled = await $.prompt.fill({ text })
  return filled.isFilled
}

/** Compacts, retrying while a turn still runs (`$.session.compact` rejects then). */
async function compact($: EngineInterface, runId: number, attempt = 1): Promise<void> {
  if (!(await isCurrent($, runId))) return
  let result
  try {
    result = await $.session.compact({ instructions: config.compactInstructions })
  } catch (err) {
    if (attempt < COMPACT_ATTEMPTS) {
      timer = $.clock.after(COMPACT_RETRY_MS, () => void compact($, runId, attempt + 1))
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
    void $.prompt.submit({ text: forSubmit(text), asUser: true }).catch(err => {
      $.ui.log(`handoff: couldn't submit the continuation prompt (${errorText(err)}); /handoff paste to retry.`)
    })
    await finish($, runId, null)
    $.ui.toast('handoff: compacted; continuation prompt sent')
    return
  }
  const isFilled = await fill($, text).catch(() => false)
  await finish($, runId, isFilled ? null : `couldn't fill the prompt box. Continuation prompt:\n\n${text}`)
  if (isFilled) $.ui.toast('handoff: compacted; review the prompt and press Enter')
}

/** After the save turn: fork the continuation prompt, keep it, then compact and deliver. */
async function continueRun($: EngineInterface, runId: number) {
  try {
    if (!(await isCurrent($, runId))) return
    $.ui.status('handoff: writing the continuation prompt…')
    const reply = await $.model.fork({ prompt: CONTINUATION_PROMPT })
    if (!reply.isAnswered) {
      await finish($, runId, `stopped: the continuation prompt failed (${reply.reason}). Nothing was compacted.`)
      return
    }
    const text = cleanContinuation(reply.text)
    if (!text) {
      await finish($, runId, 'stopped: the continuation prompt came back empty. Nothing was compacted.')
      return
    }
    await savePromptToStore($, text)
    if (config.copyToClipboard) await $.ui.copy({ text }).catch(() => undefined)
    if (!(await isCurrent($, runId))) return
    $.ui.status('handoff: compacting…')
    await compact($, runId)
  } catch (err) {
    await finish($, runId, `stopped: ${errorText(err)}`)
  }
}

export const register: Register = (on, options) => {
  config = configFrom(options)
  timer = null

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'handoff',
      description: 'Save state to durable notes, draft a continuation prompt, compact, and queue the prompt',
      argumentHint: '[focus | status | cancel | paste]',
    })
    const run = await read($, runAtom)
    if (run.phase !== 'idle') {
      await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
      $.ui.log('handoff: a run was interrupted by a reload; start again with /handoff.')
    }
    return result
  })

  on('turn.start', async ($, e, next) => {
    const run = await read($, runAtom)
    if (run.phase === 'saving' && run.saveTurnId === null && e.text.includes(SAVE_MARKER)) {
      await update($, runAtom, cur => (cur.runId === run.runId ? { ...cur, saveTurnId: e.turnId } : cur))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) return result
    const run = await read($, runAtom)
    if (run.phase !== 'saving' || run.saveTurnId !== e.turnId) return result
    if (e.reason !== 'answer') {
      await finish($, run.runId, `stopped: the save turn ended (${e.reason}). Nothing was compacted.`)
      return result
    }
    await update($, runAtom, cur => ({ ...cur, phase: 'continuing' as const }))
    // Compaction rejects while a turn runs, so continue once this one has ended.
    cancelTimer()
    timer = $.clock.after(0, () => void continueRun($, run.runId))
    return result
  })

  on('command.run', { command: 'handoff' }, async ($, e) => {
    const cmd = parseArgs(e.args)
    const run = await read($, runAtom)

    switch (cmd.kind) {
      case 'status':
        return { text: run.phase === 'idle' ? 'handoff: idle.' : `handoff: ${run.phase}.` }

      case 'cancel': {
        if (run.phase === 'idle') return { text: 'handoff: nothing to cancel.' }
        cancelTimer()
        await update($, runAtom, cur => ({ ...IDLE, runId: cur.runId + 1 }))
        $.ui.status(undefined)
        return { text: 'handoff: cancelled. Anything already saved or compacted stays.' }
      }

      case 'paste': {
        const saved = (await $.store.get('lastPrompt')) as SavedPrompt | undefined
        if (!saved?.text) return { text: 'handoff: no saved continuation prompt.' }
        const isFilled = await fill($, saved.text).catch(() => false)
        const when = new Date(saved.at).toISOString()
        return {
          text: isFilled
            ? `handoff: filled the continuation prompt saved ${when} (session ${saved.sessionId}).`
            : `handoff: couldn't fill the prompt box. Saved ${when} (session ${saved.sessionId}):\n\n${saved.text}`,
        }
      }

      case 'start': {
        if (run.phase !== 'idle') {
          return { text: `handoff: already ${run.phase}. /handoff status, or /handoff cancel to reset.` }
        }
        if ((await $.session.turns()) === 0) return { text: 'handoff: nothing to hand off yet.' }
        const runId = run.runId + 1
        const startedAt = await $.clock.now()
        await update($, runAtom, () => ({ phase: 'saving' as const, runId, saveTurnId: null, startedAt }))
        $.ui.status('handoff: saving state…')
        // The host refuses a submit from inside command.run (it would wait on
        // the turn this hook holds), so submit once the command has returned.
        const text = savePrompt(cmd.focus)
        cancelTimer()
        timer = $.clock.after(0, () => {
          void $.prompt
            .submit({ text, asUser: true })
            .then(r => (r.drop !== undefined ? finish($, runId, `stopped: the save prompt was dropped (${r.drop}).`) : undefined))
            .catch(err => finish($, runId, `stopped: couldn't submit the save prompt (${errorText(err)}).`))
        })
        return { text: 'handoff: saving state, then drafting a continuation prompt and compacting.' }
      }
    }
  })
}
