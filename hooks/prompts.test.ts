import { describe, expect, test } from 'claude-code/testing'

import {
  cleanContinuation,
  CONTINUATION_PROMPT,
  continuationPrompt,
  extractNote,
  forSubmit,
  isCanceled,
  parseArgs,
  SAVE_MARKER,
  savePrompt,
} from './prompts'

describe('parseArgs', () => {
  test('bare /handoff starts a run with no focus', async () => {
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
    const p = savePrompt('the auth refactor', '/tmp/claude-handoff/x.md')
    expect(p.startsWith(SAVE_MARKER)).toBe(true)
    expect(p).toContain('/tmp/claude-handoff/x.md')
    expect(p).toContain('the auth refactor')
    expect(p).not.toContain('HANDOFF.md')
    expect(savePrompt('', '/tmp/x.md')).not.toContain('Focus:')
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

  test('falls back to the whole message without tags', async () => {
    expect(extractNote('  # Handoff\nStep 2.  ')).toBe('# Handoff\nStep 2.')
    expect(extractNote('<handoff-note>\n</handoff-note>')).toBe('')
  })
})

describe('isCanceled', () => {
  test("recognizes the engine's cancellation, not a running turn", async () => {
    expect(isCanceled('handoff: $.session.compact: Compaction canceled.')).toBe(true)
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
})
