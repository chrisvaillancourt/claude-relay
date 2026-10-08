# relay

A Claude Code mod (function-hook plugin) that turns the checkpoint-compact-continue routine into one command, `/relay`.

When a session's context is getting full, `/relay`:

1. **Saves.** It submits a save turn. The model updates the project's docs and notes that the session made stale, in place, then ends the turn with a handoff note inside `<handoff-note>` tags. The note covers what's done, what's in progress, decisions, lessons, gotchas, workarounds, next steps and the files touched. The plugin writes the note to a temp file, `$TMPDIR/claude-relay/<project>-<UTC time>.md` (`/tmp` when `TMPDIR` is unset), so nothing new lands in the repo. The model doesn't write that file itself, so there's no permission prompt for a path outside the project.

   macOS clears `$TMPDIR` on reboot and removes files left unused for about 3 days. That's fine for the next session; set `noteDir` if you want notes kept longer.
2. **Drafts the continuation prompt.** Once the save turn ends, it asks a side question over the transcript with `$.model.fork`, the cache-served, tool-less side question `/btw` asks. The fork replays the last request, which ends before the save turn's final message, so the note is quoted into the question. The answer is a copy/paste-ready prompt that points at the files to read (`@path`, the temp note first) and adds only what they don't say. The fork doesn't add the question or the answer to the conversation. The prompt is saved to the plugin's store and, by default, copied to the clipboard.
3. **Compacts.** It runs the same compaction `/compact` does, with your instructions (default: keep what's helpful and not written to a durable location).
4. **Delivers.** It fills the prompt box with the continuation prompt, ahead of anything you'd typed there. Review it and press Enter. A typed prompt expands `@` mentions; a plugin's submitted prompt doesn't.

If any step fails, the run stops before the next one and logs why:

- A failed or interrupted save turn, a missing note, a note that can't be written, or a failed fork never compacts.
- If you cancel the compaction (Esc or Ctrl+C), the run stops; the prompt stays saved for `/relay paste`.
- If you start another turn before compaction (say, a prompt you queued during the save turn), the run stops rather than compacting over it.
- If compaction fails or is skipped, nothing is filled; the prompt stays saved for `/relay paste`. A rejected compaction is retried twice, 2 s apart, in case the save turn is still winding down.
- If the save turn can't be identified within 5 s of starting (another plugin rewrote the prompt), the run stops.

Headless sessions (`-p`, SDK) can't compact from a plugin on Claude Code 2.1.294, so there `/relay` saves and drafts the prompt, then stops with the prompt saved.

Tested end to end in an interactive session on Claude Code 2.1.294: save turn, note written to `$TMPDIR`, fork, compaction (35k → 3k tokens) and fill. Pressing Enter on the filled prompt attached the temp note through its `@` path with no permission prompt.

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

Set in `/config` (or `pluginConfigs.relay.options` in settings):

| Option | Default | |
| --- | --- | --- |
| `deliver` | `fill` | `fill` puts the prompt in the box. `submit` sends it at once and tells the model to read the `@` files, since a plugin's prompt doesn't attach them. |
| `compactInstructions` | Keep any information that's helpful to the agent and not written to a durable location. | What the compaction summary keeps. |
| `noteDir` | empty | Directory for handoff notes. Empty: `$TMPDIR/claude-relay` (else `/tmp/claude-relay`). |
| `copyToClipboard` | `true` | Also copy the continuation prompt to the clipboard. |

The save and continuation prompts live in `hooks/prompts.ts`.

## Install

This repo is its own marketplace. Install from GitHub:

```sh
claude plugin marketplace add chrisvaillancourt/claude-relay
claude plugin install relay@relay --scope user
```

A GitHub install runs a copy. It updates only when `version` in `plugin.json` changes: `claude plugin marketplace update relay`, then `claude plugin update relay@relay`.

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
