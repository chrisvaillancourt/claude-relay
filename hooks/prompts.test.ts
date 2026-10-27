import { describe, expect, test } from 'claude-code/testing'

import {
  cleanContinuation,
  CONTINUATION_PROMPT,
  continuationPrompt,
  extractNote,
  forSubmit,
  heldNotice,
  holdAppend,
  restoreHold,
  isCanceled,
  isHeldOrigin,
  parseArgs,
  promptPathFor,
  SAVE_MARKER,
  savePrompt,
  taggedNote,
  isRunRecord,
  restartNotice,
} from './prompts'

describe('parseArgs', () => {
  test('bare /relay starts a run with no focus', async () => {
    expect(parseArgs('')).toEqual({ kind: 'start', focus: '' })
    expect(parseArgs('   ')).toEqual({ kind: 'start', focus: '' })
  })

  test('subcommands are recognized case-insensitively', async () => {
    expect(parseArgs('status')).toEqual({ kind: 'status' })
    expect(parseArgs(' Cancel ')).toEqual({ kind: 'cancel' })
    expect(parseArgs('paste')).toEqual({ kind: 'paste' })
  })

  test('anything else is focus for the save turn', async () => {
    expect(parseArgs('stress the migration plan')).toEqual({ kind: 'start', focus: 'stress the migration plan' })
    // a subcommand word that starts a longer phrase is focus, not the subcommand
    expect(parseArgs('status of the deploy')).toEqual({ kind: 'start', focus: 'status of the deploy' })
  })
})

describe('savePrompt', () => {
  test('carries the marker, the note path and the focus', async () => {
    const p = savePrompt('the auth refactor', '/tmp/claude-relay/x.md')
    expect(p.startsWith(SAVE_MARKER)).toBe(true)
    expect(p).toContain('/tmp/claude-relay/x.md')
    expect(p).toContain('the auth refactor')
    expect(p).not.toContain('HANDOFF.md')
    expect(savePrompt('', '/tmp/x.md')).not.toContain('Focus:')
  })

  test('custom save instructions replace the first step and keep the note contract', async () => {
    const p = savePrompt('the auth refactor', '/tmp/x.md', 'Follow the closeout skill.')
    expect(p.startsWith(SAVE_MARKER)).toBe(true)
    expect(p).toContain('1. Follow the closeout skill.')
    expect(p).not.toContain("Update the project's docs")
    expect(p).toContain('<handoff-note>')
    expect(p).toContain('/tmp/x.md')
    expect(p).toContain("Don't start new work.")
    expect(p).toContain('Focus: the auth refactor')
  })

  test('empty save instructions keep the default first step', async () => {
    expect(savePrompt('', '/tmp/x.md', '')).toBe(savePrompt('', '/tmp/x.md'))
  })
})

describe('cleanContinuation', () => {
  test('strips a wrapping code fence and surrounding whitespace', async () => {
    expect(cleanContinuation('```\n@a.md\nGo on.\n```\n')).toBe('@a.md\nGo on.')
    expect(cleanContinuation('```text\n@a.md\n```')).toBe('@a.md')
  })

  test('matches the wrapping fence by length and kind', async () => {
    expect(cleanContinuation('````\n@a.md\n```sh\nx\n```\n````')).toBe('@a.md\n```sh\nx\n```')
    expect(cleanContinuation('~~~\n@a.md\n~~~')).toBe('@a.md')
  })

  test('leaves separate code blocks alone rather than splicing them', async () => {
    const two = '```sh\nmake test\n```\nRead @a.md then continue.\n```\nfoo\n```'
    expect(cleanContinuation(two)).toBe(two)
  })

  test('leaves inner fences and plain text alone', async () => {
    const inner = '@a.md\n\n```sh\nmake test\n```\n\nThen ship.'
    expect(cleanContinuation(`  ${inner}  `)).toBe(inner)
  })
})

describe('extractNote', () => {
  test('takes what is inside the note tags, dropping chatter around them', async () => {
    expect(extractNote('No docs were stale.\n\n<handoff-note>\n# Handoff\nStep 2.\n</handoff-note>\nDone.')).toBe('# Handoff\nStep 2.')
  })

  test('takes the tags on their own lines, not tag names quoted in prose before them', async () => {
    const answer =
      'The note goes inside `<handoff-note>` and `</handoff-note>` tags:\n\n<handoff-note>\n# Widget handoff\nRelease 0.2.0.\n</handoff-note>'
    expect(extractNote(answer)).toBe('# Widget handoff\nRelease 0.2.0.')
  })

  test('takes the last note when the message holds more than one', async () => {
    expect(extractNote('<handoff-note>\ndraft\n</handoff-note>\nRevised:\n<handoff-note>\nfinal\n</handoff-note>')).toBe('final')
  })

  test('ignores tags inside a fenced example within the note', async () => {
    const answer = [
      'Report.',
      '<handoff-note>',
      '# Handoff',
      'Draft for the ticket:',
      '```xml',
      '<handoff-note>',
      'example',
      '</handoff-note>',
      '```',
      'Next: resume the migration.',
      '</handoff-note>',
    ].join('\n')
    expect(extractNote(answer)).toBe(
      '# Handoff\nDraft for the ticket:\n```xml\n<handoff-note>\nexample\n</handoff-note>\n```\nNext: resume the migration.',
    )
  })

  test('falls back to the whole message without tags', async () => {
    expect(extractNote('  # Handoff\nStep 2.  ')).toBe('# Handoff\nStep 2.')
    expect(extractNote('<handoff-note>\n</handoff-note>')).toBe('')
  })
})

describe('isCanceled', () => {
  test("recognizes the engine's cancellation, not a running turn", async () => {
    expect(isCanceled('relay: $.session.compact: Compaction canceled.')).toBe(true)
    expect(isCanceled('Compaction cancelled by user')).toBe(true)
    expect(isCanceled('a turn is running')).toBe(false)
  })
})

describe('forSubmit', () => {
  test('tells the model to read the @ files, since a plugin prompt does not attach them', async () => {
    const out = forSubmit('@notes/hub.md\nContinue the rollout.')
    expect(out).toContain('@notes/hub.md\nContinue the rollout.')
    expect(out).toMatch(/read/i)
  })
})

describe('continuationPrompt', () => {
  test('quotes the note and asks for its path first', async () => {
    const p = continuationPrompt('# Handoff\nStep 2 done.', '/tmp/h.md')
    expect(p).toContain('<handoff-note path="/tmp/h.md">\n# Handoff\nStep 2 done.\n</handoff-note>')
    expect(p).toContain('@/tmp/h.md')
    expect(p.endsWith(CONTINUATION_PROMPT)).toBe(true)
  })

  test('a long note is cut in the quote', async () => {
    expect(continuationPrompt('x'.repeat(20_000), '/tmp/h.md').length).toBeLessThan(9_500)
  })

  test("introduces the @ files with 'Come up to speed:' and leaves instruction files to the harness", async () => {
    expect(CONTINUATION_PROMPT).toContain('Come up to speed:')
    expect(CONTINUATION_PROMPT).toMatch(/AGENTS\.md/)
    expect(CONTINUATION_PROMPT).toMatch(/don't tell the agent to read them/i)
    expect(CONTINUATION_PROMPT).not.toMatch(/Point to the files/)
  })
})

describe('promptPathFor', () => {
  test('keeps the generated prompt beside its note', async () => {
    expect(promptPathFor('/tmp/claude-relay/work-20261021T194550Z.md')).toBe('/tmp/claude-relay/work-20261021T194550Z.prompt.md')
    expect(promptPathFor('/tmp/x/note')).toBe('/tmp/x/note.prompt.md')
  })
})

describe('heldNotice', () => {
  test('carries every held message, in order, and says why they waited', async () => {
    const out = heldNotice(['<task-notification>a</task-notification>', 'Another Claude session sent a message: b'])
    expect(out).toMatch(/relay/i)
    expect(out).toContain('<task-notification>a</task-notification>')
    expect(out).toContain('Another Claude session sent a message: b')
    expect(out.indexOf('>a<')).toBeLessThan(out.indexOf(': b'))
  })
})

describe('holdAppend', () => {
  test('appends only while holding, so a delivery racing a release passes instead', async () => {
    expect(holdAppend({ isHolding: true, items: ['a'], endsAtTurn: false, gen: 1 }, 'b')).toEqual({ isHolding: true, items: ['a', 'b'], endsAtTurn: false, gen: 1 })
    expect(holdAppend({ isHolding: false, items: [], endsAtTurn: false, gen: 1 }, 'b')).toBeNull()
  })
})

describe('restoreHold', () => {
  const holding = { isHolding: true, items: ['later'], endsAtTurn: true, gen: 3 }
  test('a refused prompt that ended the hold puts its items back first and holds again', async () => {
    expect(restoreHold(holding, ['taken'], 3, true)).toEqual({ isHolding: true, items: ['taken', 'later'], endsAtTurn: false, gen: 3 })
  })
  test('a refused prompt that took nothing leaves another prompt’s handoff alone', async () => {
    expect(restoreHold(holding, [], 3, false)).toEqual(holding)
  })
  test('a hold released or restarted since (cancel, a new run) is not revived', async () => {
    expect(restoreHold({ isHolding: false, items: [], endsAtTurn: false, gen: 4 }, ['taken'], 3, true)).toBeNull()
  })
})

describe('isHeldOrigin', () => {
  test('holds background deliveries, never the person or a plugin', async () => {
    for (const kind of [
      'task-notification',
      'peer',
      'peer-send-message',
      'projects-relay',
      'coordinator',
      'observer',
      'observer-activity',
      'scheduled-trigger',
    ])
      expect(isHeldOrigin(kind)).toBe(true)
    // a channel may be the person driving the session remotely, who couldn't end a hold from there
    for (const kind of ['composer', 'bridge', 'sdk', 'slack-ping', 'channel', 'plugin', 'auto-continuation', 'unclassified'])
      expect(isHeldOrigin(kind)).toBe(false)
  })
})

describe('taggedNote', () => {
  test('is the tagged note, or null without tags, where extractNote falls back to the whole message', async () => {
    expect(taggedNote('done.\n\n<handoff-note>\n# Note\n</handoff-note>')).toBe('# Note')
    expect(taggedNote('just a reply')).toBeNull()
    expect(extractNote('just a reply')).toBe('just a reply')
  })
})

describe('run records', () => {
  test('only a well-formed record counts', async () => {
    expect(isRunRecord({ phase: 'saving', notePath: '/n.md', startedAt: 1 })).toBe(true)
    expect(isRunRecord({ phase: 'idle', notePath: '/n.md', startedAt: 1 })).toBe(false)
    expect(isRunRecord({ phase: 'saving', notePath: '/n.md' })).toBe(false)
    expect(isRunRecord(null)).toBe(false)
  })

  test('the restart notice names the run and what to do next', async () => {
    const at = Date.UTC(2026, 9, 27, 20, 49)
    const saving = restartNotice({ phase: 'saving', notePath: '/n.md', startedAt: at })
    expect(saving).toContain('20:49Z')
    expect(saving).toContain('Nothing was compacted')
    const continuing = restartNotice({ phase: 'continuing', notePath: '/n.md', startedAt: at })
    expect(continuing).toContain('/compact')
    expect(continuing).toContain('@/n.md')
  })
})
