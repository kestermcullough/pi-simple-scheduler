# pi-simple-scheduler

A [pi](https://github.com/earendil-works/pi) extension that lets the agent (or you) schedule prompts for later. It is one file of about 290 lines and has no dependencies.

```bash
pi install git:github.com/kestermcullough/pi-simple-scheduler
```

## What it does

The agent gets one tool, `schedule`, with three actions.

| Action | Fields |
| --- | --- |
| `add` | `prompt` plus one of `in` (`30m`), `at` (`2026-11-01T09:00`), `every` (`10m`, at least 1 minute) or `cron` (`0 9 * * 1-5`). Optional: `max`, `if`, `urgent`, `fresh`, `detached`. |
| `list` | Shows in-session timers and detached jobs. |
| `cancel` | `id` (in-session), a detached job name, or `all`. |

You get these commands:

```text
/loop 10m check the build
/loop "0 9 * * 1-5" summarize new issues
/remind 30m look at the deploy again
/timers
/untimer 2        (or a detached name, or all)
```

## How it works

In-session timers are kept in the session file. They come back when you resume the session and only fire while pi is running. A due prompt waits until the conversation is quiet: the agent is idle, nothing is queued, and there has been no message from you and no reply from the agent for 1 minute. So a timer never cuts into a conversation; during a long session it just waits. Set `urgent: true` on a job to skip the wait (it then queues as a follow-up if the agent is busy). Runs missed while pi was closed are merged into one run. The status line shows `⏱ N` while timers are active.

**`if` (optional).** A shell command that runs first, in the session folder. The agent is woken only when the command exits 0, and its output is added to the prompt. This keeps polling cheap, because the model only runs when something changed. A wait-until job is `every` + `if` + `max: 1`.

**`fresh` (optional).** When the job is due, a throwaway `pi -p` with a clean context does the prompt in the background, in the same folder, without waiting for a quiet moment. Its answer is passed to the main session, using the same quiet-minute rule, but only if the answer is not `NOTHING`. Checks therefore cost the main session nothing until something turns up. If several answers from the same job pile up during a long conversation, only the newest is kept. A fresh run can take up to 30 minutes.

**`detached` (optional).** Creates a systemd user timer in `~/.config/systemd/user/pi-sched-*.timer`. When it fires, it runs `pi -p "<prompt>"` as a new session in the same folder, even if pi is closed. Output goes to `~/.pi/agent/scheduler/<name>.log`. One-shot jobs remove themselves after they run. Calendar jobs use `Persistent=true`, so a run that was missed while the machine was off happens at the next start. This needs Linux with systemd (WSL with `systemd=true` works). Run `loginctl enable-linger $USER` so jobs fire without a login. `max` is not supported for detached jobs.

**Self-paced loops.** The agent schedules a one-shot `in` at the end of each run and picks the delay itself.

## Notes

- Times are local. Cron has 5 fields and supports `*`, `,`, `-` and `/`.
- There are no tests, on purpose. The code is short enough to read.

MIT license.
