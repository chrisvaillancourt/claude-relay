import { describe, expect, test } from 'claude-code/testing'

import {
  acceptedText,
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
  SAVE_MARKER,
  savePrompt,
  STALE_NOTE,
  teammateItem,
  TOOL,
  TOOL_DESCRIPTION,
  TOOL_SCHEMA,
  withSession,
} from './prompts'
import type { Hold } from '../types'

const NOTE = '/tmp/T/claude-relay/my-proj-20261007T150000Z.md'

describe('parseArgs', () => {
  test('bare /relay starts a run with no focus', async () => {
    expect(parseArgs('')).toEqual({ kind: 'start', focus: '' })
    expect(parseArgs('   ')).toEqual({ kind: 'start', focus: '' })
  })

  test('subcommands are recognized case-insensitively', async () => {
    expect(parseArgs('status')).toEqual({ kind: 'status' })
    expect(parseArgs(' Cancel ')).toEqual({ kind: 'cancel' })
    expect(parseArgs('PASTE')).toEqual({ kind: 'paste' })
  })

  test('anything else is focus for the save turn', async () => {
    expect(parseArgs('stress the rollback plan')).toEqual({ kind: 'start', focus: 'stress the rollback plan' })
  })
})

describe('notePathFor', () => {
  test('names the note for the project and the UTC start time', async () => {
    expect(notePathFor('/tmp/T/claude-relay/', '/work/my-proj/', Date.UTC(2026, 9, 7, 15, 0))).toBe(NOTE)
    expect(notePathFor('/n', '/work/my proj', Date.UTC(2026, 9, 7, 15, 0))).toBe('/n/my-proj-20261007T150000Z.md')
  })
})

describe('savePrompt', () => {
  test('carries the marker and the focus, and asks for the handoff tool', async () => {
    const p = savePrompt('stress the rollback plan')
    expect(p.startsWith(SAVE_MARKER)).toBe(true)
    expect(p).toContain(TOOL)
    expect(p).toContain('ToolSearch')
    expect(p).toContain("Don't start new work.")
    expect(p).toContain('Focus: stress the rollback plan')
  })

  test('custom save instructions replace the first step and keep the tool call', async () => {
    const p = savePrompt('', '  Follow the closeout skill.  ')
    expect(p).toContain('1. Follow the closeout skill.\n')
    expect(p).not.toContain("Update the project's docs")
    expect(p).toContain(`2. Then call the ${TOOL} tool`)
  })

  test('empty save instructions keep the default first step', async () => {
    expect(savePrompt('', '   ')).toContain("1. Update the project's docs")
  })

  test('says the same session continues after compaction', async () => {
    expect(savePrompt('')).toMatch(/same session and process/)
    expect(savePrompt('')).toMatch(/keep running through the compaction/)
  })
})

describe('the handoff tool', () => {
  test('its schema asks the note for standing instructions and running agents by id', async () => {
    const note = TOOL_SCHEMA.properties.note.description
    expect(note).toMatch(/standing instructions and approvals/)
    expect(note).toMatch(/every subagent, background session and background job still running/)
    expect(note).toMatch(/id or name/)
    expect(TOOL_SCHEMA.required).toEqual(['note', 'continuation'])
  })

  test('its description says when to call it and what happens after', async () => {
    expect(TOOL_DESCRIPTION).toMatch(/logical stopping point/)
    expect(TOOL_DESCRIPTION).toMatch(/end your turn/)
    expect(TOOL_DESCRIPTION).toMatch(/waiting on the user/)
  })

  test('takes a note, a continuation and files, trimming them and the @ prefix', async () => {
    expect(parseHandoff({ note: ' n ', continuation: ' c ', files: ['@a.md', ' b.md ', 3, ''] })).toEqual({
      note: 'n',
      continuation: 'c',
      files: ['a.md', 'b.md'],
    })
    expect(parseHandoff({ note: 'n', continuation: 'c' })).toEqual({ note: 'n', continuation: 'c', files: [] })
  })

  test('a call without a note or a continuation saves nothing and says so', async () => {
    for (const input of [{ note: 'n' }, { continuation: 'c' }, { note: '  ', continuation: 'c' }, { note: 3, continuation: 'c' }]) {
      const r = parseHandoff(input)
      expect('error' in r && /Nothing was saved/.test(r.error)).toBe(true)
    }
  })

  test('its answer says to end the turn, and how the prompt arrives', async () => {
    expect(acceptedText(NOTE, 'submit')).toContain(NOTE)
    expect(acceptedText(NOTE, 'submit')).toMatch(/End your turn now/)
    expect(acceptedText(NOTE, 'submit')).toMatch(/sends the continuation prompt/)
    expect(acceptedText(NOTE, 'fill')).toMatch(/prompt box/)
  })
})

describe('composeContinuation', () => {
  test("leads with the agent's text, then the files with the note first", async () => {
    const text = composeContinuation({ continuation: 'Resume at step 3.', files: ['notes/hub.md', NOTE, 'notes/hub.md'] }, NOTE)
    expect(text.startsWith('Resume at step 3.\n\nCome up to speed:\n')).toBe(true)
    expect(text).toContain(`Come up to speed:\n@${NOTE}\n@notes/hub.md\n\n`)
    expect(text.match(/@notes\/hub\.md/g)?.length).toBe(1)
  })

  test('a long note costs the prompt nothing: only its path is carried', async () => {
    // The fork used to be quoted the note's first 8,000 characters and called the rest truncated.
    const text = composeContinuation({ continuation: 'Go on.', files: [] }, NOTE)
    expect(text.length).toBeLessThan(600)
    expect(text).not.toMatch(/truncated|\[…\]/)
  })

  test('says running agents survive compaction and to check before relaunching', async () => {
    const text = composeContinuation({ continuation: 'Go on.', files: [] }, NOTE)
    expect(text).toMatch(/still running and still report/)
    expect(text).toMatch(/ListAgents and the task list/)
    expect(text).toMatch(/never infer that from uncommitted files or missing commits/)
  })

  test('says the summary is newer when a turn ran after the note', async () => {
    expect(composeContinuation({ continuation: 'Go on.', files: [] }, NOTE)).not.toContain(STALE_NOTE)
    expect(composeContinuation({ continuation: 'Go on.', files: [] }, NOTE, true).endsWith(STALE_NOTE)).toBe(true)
  })
})

describe('compactInstructionsFor', () => {
  test("keeps the person's instructions and points the summary at the note", async () => {
    const text = compactInstructionsFor('Keep the plan.', NOTE)
    expect(text.startsWith('Keep the plan.\n\n')).toBe(true)
    expect(text).toContain(NOTE)
    expect(text).toMatch(/standing instructions/)
    expect(text).toMatch(/after the note was written/)
  })
})

describe('isCanceled', () => {
  test("recognizes the engine's cancellation, not a running turn", async () => {
    expect(isCanceled('Compaction canceled.')).toBe(true)
    expect(isCanceled('compaction cancelled by the user')).toBe(true)
    expect(isCanceled('a turn is running')).toBe(false)
  })
})

describe('forSubmit', () => {
  test('tells the model to read the @ files, since a plugin prompt does not attach them', async () => {
    const text = forSubmit('@notes/hub.md\nResume.')
    expect(text).toMatch(/^Read every file/)
    expect(text.endsWith('@notes/hub.md\nResume.')).toBe(true)
  })
})

describe('promptPathFor', () => {
  test('keeps the prompt beside its note', async () => {
    expect(promptPathFor('/t/a-1.md')).toBe('/t/a-1.prompt.md')
    expect(promptPathFor('/t/a-1')).toBe('/t/a-1.prompt.md')
  })
})

describe('withSession', () => {
  test('adds this session unless the note already names it', async () => {
    expect(withSession('n', 'sid-1')).toBe('n\n\nSession: sid-1')
    expect(withSession('n\n\nSession: sid-1', 'sid-1')).toBe('n\n\nSession: sid-1')
    expect(withSession('n\n\nSession: old', 'sid-1')).toBe('n\n\nSession: old\n\nSession: sid-1')
  })
})

describe('the hold', () => {
  const HOLDING: Hold = { isHolding: true, items: ['a'], endsAtTurn: false, gen: 3, notice: null }

  test('heldNotice carries every held message, in order, and says why they waited', async () => {
    const text = heldNotice(['first', 'second'])
    expect(text).toMatch(/relay held these messages/)
    expect(text.indexOf('first')).toBeLessThan(text.indexOf('second'))
  })

  test('a teammate message is held under its sender’s name', async () => {
    expect(teammateItem('impl-16204', 'done')).toBe('Message from teammate impl-16204:\ndone')
  })

  test('holdAppend appends only while holding, so a delivery racing a release passes instead', async () => {
    expect(holdAppend(HOLDING, 'b')?.items).toEqual(['a', 'b'])
    expect(holdAppend({ ...HOLDING, isHolding: false }, 'b')).toBeNull()
  })

  test('a refused prompt that ended the hold puts its items and notice back and holds again', async () => {
    const after: Hold = { isHolding: true, items: ['late'], endsAtTurn: true, gen: 3, notice: null }
    expect(restoreHold(after, ['a'], 3, true, 'not compacted')).toEqual({
      isHolding: true,
      items: ['a', 'late'],
      endsAtTurn: false,
      gen: 3,
      notice: 'not compacted',
    })
  })

  test('a refused prompt that took nothing leaves another prompt’s handoff alone', async () => {
    const after: Hold = { isHolding: true, items: [], endsAtTurn: true, gen: 3, notice: null }
    expect(restoreHold(after, [], 3, false)).toEqual(after)
  })

  test('a hold released or restarted since (cancel, a new run) is not revived', async () => {
    expect(restoreHold({ ...HOLDING, gen: 4 }, ['a'], 3, true)).toBeNull()
  })

  test('holds background deliveries, never the person, a plugin, a channel or an unstamped command', async () => {
    for (const kind of ['task-notification', 'peer', 'peer-send-message', 'projects-relay', 'coordinator', 'observer', 'observer-activity', 'scheduled-trigger']) {
      expect(isHeldOrigin(kind)).toBe(true)
    }
    for (const kind of ['composer', 'bridge', 'sdk', 'plugin', 'channel', 'unclassified', 'slack-ping', 'auto-continuation']) {
      expect(isHeldOrigin(kind)).toBe(false)
    }
    for (const kind of ['composer', 'bridge', 'sdk', 'slack-ping']) expect(isPersonOrigin(kind)).toBe(true)
    for (const kind of ['plugin', 'peer', 'unclassified', 'channel']) expect(isPersonOrigin(kind)).toBe(false)
  })
})

describe('run records', () => {
  const at = Date.UTC(2026, 9, 7, 15, 0)

  test('only a well-formed record counts', async () => {
    expect(isRunRecord({ phase: 'saving', notePath: NOTE, startedAt: at })).toBe(true)
    expect(isRunRecord({ phase: 'armed', notePath: NOTE, startedAt: at, source: 'agent' })).toBe(true)
    expect(isRunRecord({ phase: 'continuing', notePath: NOTE, startedAt: at })).toBe(true)
    expect(isRunRecord({ phase: 'idle', notePath: NOTE, startedAt: at })).toBe(false)
    expect(isRunRecord({ phase: 'saving', startedAt: at })).toBe(false)
    expect(isRunRecord(null)).toBe(false)
  })

  test('a lost run’s notice names the run, what was and wasn’t compacted, and where its files are', async () => {
    const saving = lostRunNotice({ phase: 'saving', notePath: NOTE, startedAt: at }, 'restart')
    expect(saving).toMatch(/restarted this session during the save turn/)
    expect(saving).toMatch(/15:00Z/)
    expect(saving).toMatch(/Nothing was saved or compacted/)

    const armed = lostRunNotice({ phase: 'armed', notePath: NOTE, startedAt: at }, 'restart')
    expect(armed).toMatch(/NOT compacted/)
    expect(armed).toContain(NOTE)

    const continuing = lostRunNotice({ phase: 'continuing', notePath: NOTE, startedAt: at }, 'reload')
    expect(continuing).toMatch(/a plugin reload came/)
    expect(continuing).toMatch(/may not have been compacted/)
    expect(continuing).toContain(promptPathFor(NOTE))
  })

  test('the not-compacted notice gives the reason, the note and what to do', async () => {
    const text = notCompactedNotice('stopped: the turn ended (aborted).', NOTE)
    expect(text).toMatch(/NOT compacted/)
    expect(text).toContain('stopped: the turn ended (aborted).')
    expect(text).toContain(NOTE)
    expect(text).toContain(TOOL)
    expect(notCompactedNotice('x', null)).not.toMatch(/handoff note, if/)
  })
})
