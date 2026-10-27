# relay

A Claude Code mod (function-hook plugin) that turns the checkpoint-compact-continue routine into one command, `/relay`.

When a session's context is getting full, `/relay`:

1. **Saves.** It submits a save turn. The model updates the project's docs and notes that the session made stale, in place (or follows your `saveInstructions`), then ends the turn with a handoff note inside `<handoff-note>` tags. The note covers what's done, what's in progress, decisions, lessons, gotchas, workarounds, next steps and the files touched. The plugin writes the note to a temp file, `$TMPDIR/claude-relay/<project>-<UTC time>.md` (`/tmp` when `TMPDIR` is unset), so nothing new lands in the repo. Unless the note already has one, relay adds a `Session: <id>` line, so the next session can find this one's transcript. The model doesn't write that file itself, so there's no permission prompt for a path outside the project.

   macOS clears `$TMPDIR` on reboot and removes files left unused for about 3 days. That's fine for the next session; set `noteDir` if you want notes kept longer.
2. **Drafts the continuation prompt.** Once the save turn ends, it asks a side question over the transcript with `$.model.fork`, the cache-served, tool-less side question `/btw` asks. The fork replays the last request, which ends before the save turn's final message, so the note is quoted into the question. The answer is a copy/paste-ready prompt: one line on what to continue, then "Come up to speed:" and the files to read (`@path`, the temp note first), plus only what those files don't say. It doesn't tell the agent to read the `@` files or instruction files such as `AGENTS.md` and `CLAUDE.md`, since the harness attaches and loads those itself. The fork doesn't add the question or the answer to the conversation. The prompt is saved to the plugin's store, written beside the note as `<note>.prompt.md` (so you can compare it with what you sent), and, by default, copied to the clipboard.
3. **Compacts.** It runs the same compaction `/compact` does, with your instructions (default: keep what's helpful and not written to a durable location).
4. **Delivers.** It fills the prompt box with the continuation prompt, ahead of anything you'd typed there, as compaction starts. Review it and press Enter: pressed while compaction runs, Enter queues the prompt to run once compaction finishes. A typed prompt expands `@` mentions; a plugin's submitted prompt doesn't. Set `fillDuringCompaction` to `false` to fill only after compaction.

From the start of the save turn until your next prompt's turn starts, relay holds background deliveries that would start a turn on their own: a background shell or agent finishing, another session's or a coordinating session's message, a scheduled prompt. Each is dropped with a note saying relay is holding it. Your next prompt carries them as context, in the order they arrived, and anything dequeued after you press Enter but before your turn starts follows that turn as a message from relay. So nothing runs between the checkpoint and the continuation prompt, and a notification right after the save turn no longer stops the run. A delivery into a running turn isn't held. A prompt you type into the running save turn doesn't end the hold. Two kinds of message aren't held: a channel message (Slack or Telegram through an MCP server), since that may be you driving the session remotely, and a teammate's message, which the engine gives no origin, the same as a command queued with no stamp, which could be yours. If the run fails before the prompt reaches the box, a failure hands them back as a message from relay; if the box can't be filled, they stay held for the prompt you paste. If a prompt that took them is refused further down, they go back on hold. If a hand-back is itself refused, the log shows the messages in full, so nothing is lost silently. `/relay status` shows how many are held, and `/relay cancel` releases them at any time.

If any step fails, the run stops before the next one and logs why:

- A failed or interrupted save turn, a missing note, a note that can't be written, or a failed fork never compacts.
- If you cancel the compaction (Esc or Ctrl+C), the run stops; the prompt is already in the box (or, with `fillDuringCompaction` off, saved for `/relay paste`), and the log says to `/compact` before sending it.
- If you start another turn before compaction (say, a prompt you queued during the save turn), the run stops rather than compacting over it.
- If compaction fails or is skipped, the prompt is already in the box (with `fillDuringCompaction` off, nothing is filled and the prompt stays saved for `/relay paste`). The log says to run `/compact` before sending it; a prompt you already queued runs on the uncompacted conversation. A rejected compaction is retried twice, 2 s apart, in case the save turn is still winding down; meanwhile the status says not to send the prompt yet, and a prompt sent then runs on the uncompacted conversation (the log says so).
- If the save turn can't be identified within 5 s of starting (another plugin rewrote the prompt), the run stops.
- If Claude Code restarts the session mid-run (an upgrade that moves a background session to a new process, or a crash and resume), the run's state dies with the old process. relay keeps each run in progress in its store, so the new process logs that the run was lost and that nothing was compacted. If the restart came during the save turn and the resumed turn ends with a handoff note, relay saves that note to its path and logs the rest: `/compact`, then send `Continue from @<note>`, or `/relay` to start over. Records left by sessions never resumed are dropped after a week.

Headless sessions (`-p`, SDK) can't compact from a plugin on Claude Code 2.1.294, so there `/relay` saves and drafts the prompt, then stops with the prompt saved.

Tested end to end in an interactive session on Claude Code 2.1.294: save turn, note written to `$TMPDIR`, fork, compaction (35k → 3k tokens) and fill. Pressing Enter on the filled prompt attached the temp note through its `@` path with no permission prompt. 0.4.0's fill during compaction and the hold are covered by `claude plugin test`; whether Enter during a compaction queues the prompt is the engine's behavior and is still to be checked live.

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

To give the next session an instruction, type it under the filled prompt before pressing Enter; the prompt is placed ahead of anything you'd already typed.

## Options

Set in `/config`, or in settings under `pluginConfigs["relay@relay"].options` (the key is the plugin id, `<plugin>@<marketplace>`):

| Option | Default | |
| --- | --- | --- |
| `deliver` | `fill` | `fill` puts the prompt in the box. `submit` sends it at once and tells the model to read the `@` files, since a plugin's prompt doesn't attach them. |
| `compactInstructions` | Keep any information that's helpful to the agent and not written to a durable location. | What the compaction summary keeps. |
| `noteDir` | empty | Directory for handoff notes. Empty: `$TMPDIR/claude-relay` (else `/tmp/claude-relay`). |
| `copyToClipboard` | `true` | Also copy the continuation prompt to the clipboard. |
| `saveInstructions` | empty | Replaces the save turn's first step (update stale docs and notes in place). See below. |
| `fillDuringCompaction` | `true` | With `deliver: fill`, fill the box as compaction starts, so you can queue the prompt. `false`: fill once compaction has finished. |

The save and continuation prompts live in `hooks/prompts.ts`.

### Your own save step

`saveInstructions` replaces only the save turn's first step. relay still asks for the handoff note inside `<handoff-note>` tags, tells the model not to write the note file, and says not to start new work, since it needs the tagged note for the continuation prompt. Use it to run your own closeout routine, for example a skill:

```text
Follow the saving-session-state skill.
```

A skill named there must be one the model can invoke (no `disable-model-invocation`), because the save turn asks the model to load it. Whatever it runs shouldn't stop to ask questions: relay continues only once the save turn ends with the tagged note.

## Install

This repo is its own marketplace. Install from GitHub:

```sh
claude plugin marketplace add chrisvaillancourt/claude-relay
claude plugin install relay@relay --scope user
```

The install may say the `userConfig` options aren't set yet; until you set them, the defaults below apply. A GitHub install runs a copy. It updates only when `version` in `plugin.json` changes: `claude plugin marketplace update relay`, then `claude plugin update relay@relay`.

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
