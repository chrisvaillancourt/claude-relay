// session.start must never throw on its registration: the engine refuses a name it
// reserves as a built-in, or every register when no session is bound, and an uncaught
// throw skipped the rest of the hook. Headless sessions skip the command.
import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const COMMANDS = ['relay']

function world(on: On, refuse = false) {
  mock.clock(on, { now: Date.UTC(2026, 10, 13, 12) })
  const w = { attempted: [] as string[], logs: [] as string[], seq: [] as string[] }
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => {
    w.attempted.push(e.name)
    w.seq.push('command.register')
    return refuse ? { deny: `"/${e.name}" refused: it is a built-in` } : { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    w.seq.push('tool.register')
    return { value: { tool: `mcp__relay__${e.name}` } }
  })
  on('ui.log', ($, e) => {
    w.logs.push(e.text)
    return { value: undefined }
  })
  on('state.get', ($, e, next) => {
    w.seq.push('state.get')
    return next(e)
  })
  return w
}

const notRegistered = (w: { logs: string[] }, name: string) => w.logs.filter(l => l.includes(`/${name} not registered`))

describe('relay startup', () => {
  test('a headless session.start registers no command and still answers', async ($, on) => {
    const w = world(on)
    const res = await $.session.start({ cwd: '/x', surface: null, isInteractive: false })
    expect(res.cwd).toBe('/x')
    expect(w.attempted).toEqual([])
    expect(COMMANDS.flatMap(c => notRegistered(w, c))).toHaveLength(COMMANDS.length)
  })

  test('a refused command registration is logged once and session.start carries on', async ($, on) => {
    const w = world(on, true)
    const res = await $.session.start({ cwd: '/x', surface: 'terminal', isInteractive: true })
    expect(res.cwd).toBe('/x')
    expect(w.attempted).toEqual(COMMANDS)
    for (const c of COMMANDS) expect(notRegistered(w, c)).toHaveLength(1)
    // The work after registration still ran.
    const first = w.seq.indexOf('command.register')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(w.seq.slice(first + 1)).toContain('state.get')
  })
})
