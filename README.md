# relay

A Claude Code mod (function-hook plugin) that hands a long session off to itself across a compaction. The state goes to files first, so the conversation can drop detail it no longer needs without losing it.

There are two ways in, and both end in the same tool call:

- **You** type `/relay`. relay submits a save turn that updates stale docs and then calls the handoff tool.
- **The agent** calls the `mcp__relay__handoff` tool by itself at a logical stopping point, with nobody at the keyboard.

## What a handoff does

1. **Saves.** The model calls `mcp__relay__handoff` with a handoff note, a continuation prompt and the files to read first. The note covers what's done, what's in progress, decisions, your standing instructions still in force, lessons, gotchas, next steps, the files touched, and every subagent, background session and background job still running (id, what it's doing, how it reports). relay writes the note to `$TMPDIR/claude-relay/<project>-<UTC time>.md` (`/tmp` when `TMPDIR` is unset) and the prompt beside it as `<note>.prompt.md`, so nothing new lands in the repo and no permission prompt is raised for a path outside the project. Unless the note already names this session, relay adds a `Session: <id>` line, so a later session can find this one's transcript. The note is saved whole, at any length.

   macOS clears `$TMPDIR` on reboot and removes files left unused for about 3 days. That's fine for the continuation; set `noteDir` if you want notes kept longer.
2. **Compacts when that turn ends.** It runs the same compaction `/compact` does, with your instructions (`compactInstructions`, or the text of `instructionsFile`; default: keep what's helpful and not written to a durable location) plus one of relay's own: the note is on disk and is read again right after, so the summary can stay short where the note covers something, and keeps in full your standing instructions, what the note leaves out and what happened after it.
3. **Delivers the continuation prompt.** The prompt is the agent's own text, then "Come up to speed:" and the files to read (`@path`, the note first), then a fixed reminder that compaction keeps the same session and process: subagents and background jobs are still running, and the agent should check `ListAgents` and the task list before treating one as dead or relaunching it.
   - **A run you started** fills the prompt box, ahead of anything you'd typed there, as compaction starts. Review it and press Enter: pressed while compaction runs, Enter queues the prompt to run once compaction finishes. A typed prompt expands `@` mentions. Set `fillDuringCompaction` to `false` to fill only after compaction, or `deliver` to `submit` to send it without review.
   - **A run the agent started** is always sent at once, since nobody may be there to press Enter. A plugin's prompt doesn't expand `@` mentions, so the model is told to read the files.

No model call is made besides the compaction itself: the continuation prompt is written by the turn that knows the work, not drafted afterward.

## When the agent hands off by itself

The tool is in the model's tool list with a description of when to use it: at a logical stopping point, when the context is large and work remains; not when the task is nearly done or while waiting on you. Before calling, the agent updates the docs, notes and tickets the session made stale, so the note links to them instead of repeating them.

relay declines the call, and says why, when:

- the context is under `minTokens` (default 100,000), where a compaction costs more than it saves; `/relay` hands off at any size;
- a subagent or teammate calls it (only the main conversation is compacted);
- `note` or `continuation` is missing;
- a handoff is already saved for this turn;
- you cancelled this turn's `/relay`, or typed a prompt over the running turn: your prompt runs next, and a handoff now would compact over it. The block ends when the next turn starts.

Headless sessions (`claude -p`, SDK) register the tool but not `/relay`. There relay compacts through `/compact` as the turn ends and sends the continuation. This path follows what the checkpoint mod does on Claude Code 2.1.312 and is covered by `claude plugin test`, not yet by a live headless run. `/compact` run this way doesn't report a skip (a `PreCompact` hook's veto), so relay checks that the context shrank and stops the run if it didn't. If the context size isn't available beforehand, relay doesn't compact at all and tells the model so.

## Nothing runs between the handoff and the continuation

From the handoff call until the continuation prompt's turn starts, relay holds deliveries that would start a turn on their own: a background shell or agent finishing, another session's or a coordinating session's message, a scheduled prompt, and a teammate's message or idle notice. Each is taken with a note saying relay is holding it. The continuation prompt carries them, in the order they arrived: as context on the prompt you send, or in the text of the one relay sends. Anything that arrives after you press Enter but before your turn starts follows that turn as a message from relay.

A teammate's message raises no `prompt.submit` on Claude Code 2.1.325. It arrives at `session.receive`, and starts a turn once the session is idle even when it came in while a turn was running, so relay holds it there and names its sender. A delivery into a running turn (a task notification with a turn id) isn't held. Two kinds aren't held at all: a channel message (Slack or Telegram through an MCP server), since that may be you driving the session remotely, and a command queued with no stamp, which could be yours.

A message that was already queued before the handoff call can't be taken back, and starts a turn the moment the handoff's turn ends. relay doesn't stop for that: it waits for that turn to end, then compacts and delivers, and the continuation prompt says a turn ran after the note and that the compaction summary is the newer of the two. It waits out up to three such turns in a row; a fourth stops the run.

If the run fails before the prompt reaches the box, the held messages go back to the session as a message from relay; if the box can't be filled, they stay held for the prompt you paste. If a prompt that took them is refused further down, they go back on hold. If a hand-back is itself refused, the log shows the messages in full, so nothing is lost silently. What's held is also kept in relay's store, since a held teammate message is in no queue and no transcript: if Claude Code restarts the session, the new process hands it back. `/relay status` shows how many are held, and `/relay cancel` releases them at any time.

## When a run stops

If any step fails, the run stops before the next one. The tool's answer told the model a compaction was coming, so relay always corrects that, without needing anyone to notice a toast:

- **The agent's own run:** relay sends the model a message that the conversation was NOT compacted, why, and where the note is, so it carries on and can hand off again later.
- **Your run:** your next prompt carries the same message as context the model reads; if relay has held messages to hand back first, the message goes with them, so that turn doesn't run believing in a compaction either. The log has the reason, with a toast and a desktop notification (which reaches your `Notification` hooks as `plugin_notification` even in a detached `claude --bg` session).

What stops a run:

- The save turn ends without calling the tool, or is interrupted; the note can't be written.
- **Your own prompt arrives before the compaction** (typed into the save turn before or after the tool call, queued behind it, or sent between compaction retries with nothing in the box). It's yours to run now, so the run stops rather than compacting over it, and that prompt tells the model. A prompt you send while the compaction is in flight is queued behind it and the run goes on.
- The continuation prompt is refused further down (another plugin's hook) after the compaction. For the agent's run, relay then points the model at the prompt file.
- You cancel the compaction (Esc or Ctrl+C). The prompt is already in the box (or, with `fillDuringCompaction` off, saved for `/relay paste`), and the log says to `/compact` before sending it.
- Compaction fails or is skipped. A rejected compaction is retried twice, 2 s apart; meanwhile the status says not to send the prompt yet. With the prompt already in the box, sending it then runs it on the uncompacted conversation, and the model is told so.
- The save turn can't be identified within 5 s of starting (another plugin rewrote the prompt).
- A turn the compaction was waiting for is interrupted.
- **A plugin reload during the compaction** resets the run. The log (and, for the agent's run, a message to the model) says where the note and the continuation prompt are. A reload before the turn ends doesn't lose the run: it delivers from the prompt saved beside the note.
- **Claude Code restarts the session mid-run** (an upgrade that moves a background session to a new process, or a crash and resume). The run's state dies with the old process, so relay keeps each run in progress in its store; the new process logs that the run was lost and what to do next, with a toast and a desktop notification, and tells the model when the run was the agent's. Records left by sessions never resumed are dropped after a week.

## Command

```text
/relay [focus]   run it; optional focus is appended to the save prompt
/relay status    idle, or which phase and for how long
/relay cancel    stop a run (anything already written or compacted stays)
/relay paste     fill the prompt box with the last continuation prompt, from any session
```

`status`, `cancel` and `paste` are matched whole and ignore case. Any other text is the focus.

Use `/relay` mid-session to free up context and keep going: the save turn only records where things stand, and the work continues after you press Enter on the filled prompt. The save prompt tells the model not to start new work, since anything started then would be compacted half-done. So use the focus to say what the note should cover, including what you'll do next, not to give the model a task:

```text
/relay next I'm wiring the retry logic into the uploader; make sure the note covers what that needs
```

To give the continuation an instruction, type it under the filled prompt before pressing Enter; the prompt is placed ahead of anything you'd already typed.

## Options

Set in `/config`, or in settings under `pluginConfigs["relay@relay"].options` (the key is the plugin id, `<plugin>@<marketplace>`):

| Option | Default | |
| --- | --- | --- |
| `deliver` | `fill` | For a run you start. `fill` puts the prompt in the box. `submit` sends it at once and tells the model to read the `@` files, since a plugin's prompt doesn't attach them. The agent's own run is always sent. |
| `compactInstructions` | Keep any information that's helpful to the agent and not written to a durable location. | What the compaction summary keeps. relay adds that the note is on disk. |
| `instructionsFile` | empty | A file whose text replaces `compactInstructions`, read at each compaction, so one file can serve relay and your own hooks. A leading `~` is your home directory. If it's missing, unreadable or empty, relay logs that and uses `compactInstructions`. |
| `noteDir` | empty | Directory for handoff notes. Empty: `$TMPDIR/claude-relay` (else `/tmp/claude-relay`). |
| `copyToClipboard` | `true` | Also copy the continuation prompt to the clipboard (runs you start only). |
| `saveInstructions` | empty | Replaces the save turn's first step (update stale docs and notes in place). See below. |
| `fillDuringCompaction` | `true` | With `deliver: fill`, fill the box as compaction starts, so you can queue the prompt. `false`: fill once compaction has finished. |
| `minTokens` | `100000` | The agent's own handoff is declined below this context size. |

The save prompt, the tool's description and the continuation prompt's fixed text live in `hooks/prompts.ts`.

### Your own save step

`saveInstructions` replaces only the save turn's first step. relay still asks for the handoff tool call and says not to start new work. Use it to run your own closeout routine, for example a skill:

```text
Follow the saving-session-state skill.
```

A skill named there must be one the model can invoke (no `disable-model-invocation`), because the save turn asks the model to load it. Whatever it runs shouldn't stop to ask questions: relay continues only once the save turn calls the tool and ends.

## Troubleshooting

Each run writes one line to the debug log when it ends (`claude --debug`, or `~/.claude/debug/<session id>.txt`):

```sh
grep -h 'relay\] .*run done' ~/.claude/debug/*.txt
# [relay] $.ui.log: run done phase=saving|armed|continuing outcome=delivered|stopped|cancelled deliver=fill|submit source=person|agent
```

`phase=saving` ended before the tool call; `armed` after it, before the turn ended; `continuing` got to the compaction. A `stopped` line is followed by the reason. A compaction that waited for a turn logs `compaction deferred (n)`. A refused registration logs `/relay not registered: …` or `tool handoff not registered: …` instead of stopping the session start.

## What has been checked live

- Claude Code 2.1.294, interactive: an earlier version's save turn, note in `$TMPDIR`, compaction (35k → 3k tokens) and fill; Enter on the filled prompt attached the note through its `@` path with no permission prompt.
- Enter during a compaction queues the prompt, which runs once compaction finishes (confirmed by use, 2026-11).
- Claude Code 2.1.325, 2026-11-14, with an observer mod and a live teammate: a teammate's message and idle notice raise `session.receive` with origin `{kind: "peer", teammate, isVerified: true}` and no `prompt.submit`; one that arrives mid-turn starts a turn of its own when the running turn ends.
- Claude Code 2.1.325, 2026-11-14, interactive, a handoff the agent started: the tool call saved the note and the prompt, the conversation was compacted when the turn ended, and the continuation prompt arrived as a submitted message with the note listed first. A background job that finished during the compaction didn't start a turn; its notification arrived inside the continuation prompt. The debug log read `run done phase=continuing outcome=delivered deliver=submit source=agent`.

Not yet run live: the headless path, and holding a teammate's message at `session.receive` (that `{consumed}` there keeps it out of the queue is from the API types). Everything else here is covered by `claude plugin test`.

## Install

This repo is its own marketplace. Install from GitHub:

```sh
claude plugin marketplace add chrisvaillancourt/claude-relay
claude plugin install relay@relay --scope user
```

The install may say the `userConfig` options aren't set yet; until you set them, the defaults above apply. A GitHub install runs a copy. It updates only when `version` in `plugin.json` changes: `claude plugin marketplace update relay`, then `claude plugin update relay@relay`.

Or from a local clone:

```sh
claude plugin marketplace add /path/to/claude-relay
claude plugin install relay@relay --scope user
```

A folder marketplace is read from the clone itself. After an edit, run `/reload-plugins`; no version bump or reinstall is needed. `claude plugin list` shows `Read from: <clone>`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

To try it without installing: `claude --plugin-dir .`.

## License

[MIT](LICENSE).
