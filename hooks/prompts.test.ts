import { describe, expect, test } from 'claude-code/testing'

import { cleanContinuation, forSubmit, parseArgs, SAVE_MARKER, savePrompt } from './prompts'

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
  test('carries the marker and the focus', async () => {
    const p = savePrompt('the auth refactor')
    expect(p.startsWith(SAVE_MARKER)).toBe(true)
    expect(p).toContain('the auth refactor')
    expect(savePrompt('')).not.toContain('Focus:')
  })
})

describe('cleanContinuation', () => {
  test('strips a wrapping code fence and surrounding whitespace', async () => {
    expect(cleanContinuation('```\n@a.md\nGo on.\n```\n')).toBe('@a.md\nGo on.')
    expect(cleanContinuation('```text\n@a.md\n```')).toBe('@a.md')
  })

  test('leaves inner fences and plain text alone', async () => {
    const inner = '@a.md\n\n```sh\nmake test\n```\n\nThen ship.'
    expect(cleanContinuation(`  ${inner}  `)).toBe(inner)
  })
})

describe('forSubmit', () => {
  test('tells the model to read the @ files, since a plugin prompt does not attach them', async () => {
    const out = forSubmit('@notes/hub.md\nContinue the rollout.')
    expect(out).toContain('@notes/hub.md\nContinue the rollout.')
    expect(out).toMatch(/read/i)
  })
})
