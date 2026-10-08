# handoff

A Claude Code mod (function-hook plugin) that turns the checkpoint-compact-continue routine into one command, `/handoff`.

When a session's context is getting full, `/handoff`:

1. **Saves.** It submits a save turn. The model writes its working state to durable files (the project's own handoff notes, hubs or logs, per CLAUDE.md / AGENTS.md) and updates stale docs. It records decisions, lessons, gotchas, workarounds and next steps.
2. **Drafts the continuation prompt.** Once the save turn ends, it asks a side question over the transcript with `$.model.fork`, the cache-served, tool-less side question `/btw` asks. The fork replays the last request, which ends before the save turn's final reply, so that reply is quoted into the question. The answer is a copy/paste-ready prompt that points at the files to read (`@path`) and adds only what they don't say. The fork doesn't add the question or the answer to the conversation. The prompt is saved to the plugin's store and, by default, copied to the clipboard.
3. **Compacts.** It runs the same compaction `/compact` does, with your instructions (default: keep what's helpful and not written to a durable location).
4. **Delivers.** It fills the prompt box with the continuation prompt, ahead of anything you'd typed there. Review it and press Enter. A typed prompt expands `@` mentions; a plugin's submitted prompt doesn't.

If any step fails, the run stops before the next one and logs why:

- A failed or interrupted save turn, or a failed fork, never compacts.
- If you start another turn before compaction (say, a prompt you queued during the save turn), the run stops rather than compacting over it.
- If compaction fails or is skipped, nothing is filled; the prompt stays saved for `/handoff paste`. A rejected compaction is retried twice, 2 s apart, in case the save turn is still winding down.
- If the save turn can't be identified within 5 s of starting (another plugin rewrote the prompt), the run stops.

Headless sessions (`-p`, SDK) can't compact from a plugin on Claude Code 2.1.294, so there `/handoff` saves and drafts the prompt, then stops with the prompt saved.

Tested end to end in an interactive session on Claude Code 2.1.294: save turn, fork, compaction (35k → 3k tokens) and fill.

## Command

```text
/handoff [focus]   run it; optional focus is appended to the save prompt
/handoff status    idle, or which phase and for how long
/handoff cancel    stop a run (anything already written or compacted stays)
/handoff paste     fill the prompt box with the last continuation prompt, from any session
```

## Options

Set in `/config` (or `pluginConfigs.handoff.options` in settings):

| Option | Default | |
| --- | --- | --- |
| `deliver` | `fill` | `fill` puts the prompt in the box. `submit` sends it at once and tells the model to read the `@` files, since a plugin's prompt doesn't attach them. |
| `compactInstructions` | Keep any information that's helpful to the agent and not written to a durable location. | What the compaction summary keeps. |
| `copyToClipboard` | `true` | Also copy the continuation prompt to the clipboard. |

The save and continuation prompts live in `hooks/prompts.ts`.

## Install

This repo is its own marketplace. From a local clone:

```sh
claude plugin marketplace add ~/dev/github/chrisvaillancourt/claude-handoff
claude plugin install handoff@handoff --scope user
```

A folder marketplace is read from the clone itself. After an edit, run `/reload-plugins`; no version bump or reinstall is needed. `claude plugin list` shows `Read from: <clone>`.

From GitHub, once the repo has a remote you can read:

```sh
claude plugin marketplace add chrisvaillancourt/claude-handoff
claude plugin install handoff@handoff --scope user
```

A GitHub install runs a copy. It updates only when `version` in `plugin.json` changes: `claude plugin marketplace update handoff`, then `claude plugin update handoff@handoff`.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

To try it without installing: `claude --plugin-dir .`.

## License

Private. All rights reserved.
