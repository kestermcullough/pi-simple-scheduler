/**
 * pi-simple-scheduler: let pi (or you) schedule prompts for later.
 *
 * Tool `schedule`:
 *   add    prompt + one of: in "30m" | at "2026-11-01T09:00" | every "10m" | cron "0 9 * * 1-5"
 *          optional: max (runs), if (shell check, wake only when it exits 0), detached (systemd, runs with pi closed)
 *   list   cancel (id, systemd name, or "all")
 * Commands: /loop 10m <prompt>, /loop "0 9 * * 1-5" <prompt>, /remind 30m <prompt>, /timers, /untimer <id|all>
 *
 * In-session timers are saved in the session, come back on /resume, and only fire while pi runs.
 * A due prompt waits until the conversation is quiet: agent idle, nothing queued, and no message from you or
 * reply from the agent for 1 minute. `urgent` jobs skip the wait and queue as a follow-up if the agent is busy.
 * Detached jobs are systemd user timers that run `pi -p` as a new session in the same folder.
 */
import { exec, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

type Job = { id: number; prompt: string; next: number; every?: number; cron?: string; if?: string; urgent?: boolean; fires: number; max?: number };
type State = { jobs: Job[]; nextId: number };
type AddOpts = { prompt: string; in?: string; at?: string; every?: string; cron?: string; if?: string; urgent?: boolean; max?: number; detached?: boolean };
const QUIET_MS = 60_000;

const UNIT: Record<string, number> = { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 };
const dur = (s: string) => {
	const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([smhd])$/i);
	if (!m) throw new Error(`bad duration "${s}" (use 30s, 10m, 2h, 1d)`);
	return Number(m[1]) * UNIT[m[2].toLowerCase()];
};

// 5-field cron (min hour dom month dow), local time. Supports * , - /
const field = (f: string, v: number, lo: number) =>
	f.split(",").some((p) => {
		const [r, st] = p.split("/");
		const step = st ? Number(st) : 1;
		const [a, b] = r === "*" ? [lo, 99] : r.split("-").map(Number);
		return v >= a && v <= (b ?? (st ? 99 : a)) && (v - a) % step === 0;
	});
const nextCron = (expr: string, from = Date.now()) => {
	const f = expr.trim().split(/\s+/);
	if (f.length !== 5) throw new Error(`bad cron "${expr}"`);
	const d = new Date(from);
	d.setSeconds(0, 0);
	for (let i = 0; i < 366 * 1440; i++) {
		d.setMinutes(d.getMinutes() + 1);
		if (field(f[0], d.getMinutes(), 0) && field(f[1], d.getHours(), 0) && field(f[2], d.getDate(), 1) &&
			field(f[3], d.getMonth() + 1, 1) && field(f[4], d.getDay(), 0)) return d.getTime();
	}
	throw new Error(`cron "${expr}" never fires`);
};

const describe = (j: Job) =>
	`#${j.id} ${j.cron ? `cron ${j.cron}` : j.every ? `every ${j.every / 6e4}m` : "once"} ` +
	`next ${new Date(j.next).toLocaleString()}${j.max ? ` (${j.fires}/${j.max})` : ""}${j.urgent ? " urgent" : ""}${j.if ? ` if \`${j.if}\`` : ""}: ${j.prompt}`;

const check = (cmd: string, cwd: string) =>
	new Promise<{ ok: boolean; out: string }>((done) =>
		exec(cmd, { cwd, shell: "/bin/bash", timeout: 120_000, maxBuffer: 1e6 }, (err, so, se) =>
			done({ ok: !err, out: `${so}${se}`.trim().slice(-4000) })));

// ---------- detached: systemd user timers ----------
const UNITS = join(homedir(), ".config/systemd/user");
const DIR = join(homedir(), ".pi/agent/scheduler");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sctl = (...a: string[]) => execFileSync("systemctl", ["--user", ...a], { encoding: "utf8", stdio: "pipe" });
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const cronToCalendar = (expr: string) => {
	const [mi, h, dom, mon, dow] = expr.trim().split(/\s+/);
	const conv = (f: string, lo: number, names?: string[]) =>
		f === "*" ? "*" : f.split(",").map((p) => {
			const [r, st] = p.split("/");
			let out = (r === "*" ? String(lo) : r).replace("-", "..");
			if (names) out = out.split("..").map((n) => names[Number(n)]).join("..");
			return st ? `${out}/${st}` : out;
		}).join(",");
	const cal = `${dow === "*" ? "" : `${conv(dow, 0, DOW)} `}*-${conv(mon, 1)}-${conv(dom, 1)} ${conv(h, 0)}:${conv(mi, 0)}:00`;
	execFileSync("systemd-analyze", ["calendar", cal], { stdio: "ignore" }); // throws if systemd rejects it
	return cal;
};
const calendarAt = (t: number) => {
	const d = new Date(t), p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function addDetached(o: AddOpts, cwd: string) {
	if (o.max) throw new Error("max is not supported with detached");
	const name = `pi-sched-${Date.now().toString(36)}`;
	const once = !o.every && !o.cron;
	const when = o.cron ? `OnCalendar=${cronToCalendar(o.cron)}\nPersistent=true`
		: o.every ? `OnActiveSec=${Math.max(dur(o.every), 6e4) / 1e3}s\nOnUnitActiveSec=${Math.max(dur(o.every), 6e4) / 1e3}s`
		: `OnCalendar=${calendarAt(o.at ? new Date(o.at).getTime() : Date.now() + dur(o.in ?? ""))}\nPersistent=true`;
	const script = join(DIR, `${name}.sh`);
	const units = [join(UNITS, `${name}.timer`), join(UNITS, `${name}.service`)];
	mkdirSync(DIR, { recursive: true });
	mkdirSync(UNITS, { recursive: true });
	writeFileSync(script, [
		"#!/bin/bash",
		`exec >>${q(join(DIR, `${name}.log`))} 2>&1`,
		`export PATH=${q(process.env.PATH ?? "")}`,
		`cd ${q(cwd)} || exit 1`,
		`echo "=== $(date -Is)"`,
		`prompt=${q(`[scheduled ${name}] ${o.prompt}`)}`,
		o.if ? `out=$(bash -c ${q(o.if)} 2>&1) || { echo "check failed, not waking: \${out: -500}"; exit 0; }\nprompt="$prompt\n\n[check output]\n\${out: -4000}"` : "",
		`pi -p "$prompt"`,
		once ? `systemctl --user disable --now ${name}.timer; rm -f ${units.map(q).join(" ")} ${q(script)}; systemctl --user daemon-reload` : "",
	].join("\n"));
	const desc = `${o.prompt}${o.if ? ` [if ${o.if}]` : ""}`.replace(/\s+/g, " ").replace(/%/g, "%%").slice(0, 200);
	writeFileSync(units[0], `[Unit]\nDescription=${desc}\n\n[Timer]\n${when}\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n`);
	writeFileSync(units[1], `[Unit]\nDescription=${desc}\n\n[Service]\nType=oneshot\nExecStart=/bin/bash ${script}\n`);
	sctl("daemon-reload");
	sctl("enable", "--now", `${name}.timer`);
	return `${name} (${when.split("\n")[0]}), log ${join(DIR, `${name}.log`)}`;
}

const listDetached = () => {
	if (!existsSync(UNITS)) return [];
	return readdirSync(UNITS).filter((f) => /^pi-sched-.*\.timer$/.test(f)).map((f) => {
		const name = f.replace(/\.timer$/, "");
		const desc = readFileSync(join(UNITS, f), "utf8").match(/^Description=(.*)$/m)?.[1] ?? "";
		let next = "?";
		try { next = sctl("show", f, "-p", "NextElapseUSecRealtime", "--value").trim() || "none"; } catch {}
		return `${name} detached next ${next}: ${desc.replace(/%%/g, "%")}`;
	});
};

const cancelDetached = (name: string) => {
	try { sctl("disable", "--now", `${name}.timer`); } catch {}
	rmSync(join(UNITS, `${name}.timer`), { force: true });
	rmSync(join(UNITS, `${name}.service`), { force: true });
	rmSync(join(DIR, `${name}.sh`), { force: true });
	sctl("daemon-reload");
};

// ---------- extension ----------
export default function (pi: ExtensionAPI) {
	let s: State = { jobs: [], nextId: 1 };
	let tick: ReturnType<typeof setInterval> | undefined;
	let ctx: ExtensionContext | undefined;
	const busy = new Set<number>();
	let lastActivity = Date.now();
	const quiet = () => ctx?.isIdle() !== false && !ctx?.hasPendingMessages() && Date.now() - lastActivity >= QUIET_MS;

	const save = () => {
		pi.appendEntry<State>("pi-simple-scheduler", s);
		ctx?.ui.setStatus("pi-simple-scheduler", s.jobs.length ? `⏱ ${s.jobs.length}` : undefined);
	};

	const add = (o: AddOpts) => {
		if (o.detached) return addDetached(o, ctx?.cwd ?? process.cwd());
		const every = o.every ? Math.max(dur(o.every), 6e4) : undefined;
		const next = o.cron ? nextCron(o.cron) : o.at ? new Date(o.at).getTime() : Date.now() + (o.in ? dur(o.in) : every ?? NaN);
		if (!Number.isFinite(next)) throw new Error("give one of: in, at, every, cron");
		const job: Job = { id: s.nextId++, prompt: o.prompt, next, every, cron: o.cron, if: o.if, urgent: o.urgent, fires: 0, max: o.max };
		s.jobs.push(job);
		save();
		return describe(job);
	};

	const list = () => [...s.jobs.map(describe), ...listDetached()].join("\n") || "no timers";

	const cancel = (id: string) => {
		id = id.trim().replace("#", "");
		let n = 0;
		for (const name of listDetached().map((l) => l.split(" ")[0]))
			if (id === "all" || id === name) { cancelDetached(name); n++; }
		const before = s.jobs.length;
		s.jobs = id === "all" ? [] : s.jobs.filter((j) => String(j.id) !== id);
		if (s.jobs.length !== before) save();
		return `cancelled ${n + before - s.jobs.length}`;
	};

	const run = async (j: Job) => {
		busy.add(j.id);
		const recurring = Boolean(j.every || j.cron);
		let msg = `[timer #${j.id}${recurring ? `, run ${j.fires + 1}${j.max ? `/${j.max}` : ""}` : ""}] ${j.prompt}`;
		const gate = j.if ? await check(j.if, ctx?.cwd ?? process.cwd()) : { ok: true, out: "" };
		busy.delete(j.id);
		if (!s.jobs.includes(j)) return; // cancelled or session switched while checking
		if (gate.ok) {
			if (!j.urgent && !quiet()) return; // you started talking during the check; stay due and retry later
			if (j.if) msg += `\n\n[check output]\n${gate.out}`;
			pi.sendUserMessage(msg, { deliverAs: "followUp" }); // starts a turn when idle, queues when busy
			lastActivity = Date.now(); // one wake per quiet window
			j.fires++;
		}
		const now = Date.now();
		if (!recurring || (j.max && j.fires >= j.max)) s.jobs = s.jobs.filter((x) => x !== j);
		else j.next = j.cron ? nextCron(j.cron, now) : now + j.every!; // missed runs collapse into one
		if (gate.ok || !recurring) save(); // a failed check on a loop only moves `next`; no need to write it
	};

	pi.on("session_start", async (_e, c) => {
		ctx = c;
		s = { jobs: [], nextId: 1 };
		for (const e of c.sessionManager.getBranch())
			if (e.type === "custom" && e.customType === "pi-simple-scheduler") s = structuredClone(e.data as State);
		c.ui.setStatus("pi-simple-scheduler", s.jobs.length ? `⏱ ${s.jobs.length}` : undefined);
		tick ??= setInterval(() => {
			const now = Date.now();
			for (const j of s.jobs) if (j.next <= now && !busy.has(j.id) && (j.urgent || quiet())) void run(j);
		}, 1000);
		tick.unref?.(); // never keep `pi -p` alive
	});
	pi.on("input", async () => {
		lastActivity = Date.now();
	});
	pi.on("agent_end", async () => {
		lastActivity = Date.now();
	});
	pi.on("session_shutdown", async () => {
		clearInterval(tick);
		tick = undefined;
	});

	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		description:
			"Schedule a prompt to be sent to you later, so you can wake yourself up instead of using sleep. " +
			"add: prompt plus one of in ('30m'), at (ISO local time), every ('10m', min 1m), cron ('0 9 * * 1-5'). " +
			"Due prompts wait until the user and you have been quiet for 1 minute, so they never cut into a conversation; " +
			"urgent: true skips that wait (use only when the user asked to be told right away). " +
			"Optional: max (number of runs); if (shell command run first, wake only when it exits 0, its output is appended); " +
			"detached (true = systemd timer that runs `pi -p` in a fresh session here, even with pi closed). " +
			"list: show timers. cancel: id, detached name, or 'all'. " +
			"For a self-paced loop, schedule a one-shot 'in' at the end of each run. For wait-until, use every + if + max 1. " +
			"Clean up after yourself: when the job a loop was for is done, cancel it. Never leave loops or detached jobs running " +
			"with nothing left to do; prefer max or a one-shot over open-ended loops.",
		parameters: Type.Object({
			action: StringEnum(["add", "list", "cancel"] as const),
			prompt: Type.Optional(Type.String()),
			in: Type.Optional(Type.String()),
			at: Type.Optional(Type.String()),
			every: Type.Optional(Type.String()),
			cron: Type.Optional(Type.String()),
			max: Type.Optional(Type.Number()),
			if: Type.Optional(Type.String()),
			detached: Type.Optional(Type.Boolean()),
			urgent: Type.Optional(Type.Boolean()),
			id: Type.Optional(Type.String()),
		}),
		async execute(_id, p) {
			const out = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
			if (p.action === "list") return out(list());
			if (p.action === "cancel") return out(cancel(p.id ?? ""));
			if (!p.prompt) throw new Error("prompt required");
			return out(`scheduled ${add(p as AddOpts)}`);
		},
	});

	const cmd = (name: string, description: string, opts: (spec: string) => Partial<AddOpts>) =>
		pi.registerCommand(name, {
			description,
			handler: async (args, c) => {
				const m = args.trim().match(/^"([^"]+)"\s+(.+)$/s) ?? args.trim().match(/^(\S+)\s+(.+)$/s);
				if (!m) return c.ui.notify(`usage: /${name} <10m | "cron expr"> <prompt>`, "warning");
				try {
					c.ui.notify(`scheduled ${add({ prompt: m[2], ...opts(m[1]) })}`, "info");
				} catch (err) {
					c.ui.notify(String(err), "error");
				}
			},
		});
	cmd("loop", 'Repeat a prompt: /loop 10m <prompt> or /loop "0 9 * * 1-5" <prompt>', (spec) =>
		spec.includes(" ") ? { cron: spec } : { every: spec });
	cmd("remind", "Send a prompt once later: /remind 30m <prompt>", (spec) => ({ in: spec }));
	pi.registerCommand("timers", { description: "List timers", handler: async (_a, c) => c.ui.notify(list(), "info") });
	pi.registerCommand("untimer", {
		description: "Cancel a timer: /untimer <id|name|all>",
		handler: async (a, c) => c.ui.notify(cancel(a.trim() || "all"), "info"),
	});
}
