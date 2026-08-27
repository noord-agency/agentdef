#!/usr/bin/env node
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import updateNotifier from 'update-notifier';
import { exportToClaudeCode } from './adapters/claude-code.js';
import { exportToAgentsMd } from './adapters/agents-md.js';
import { exportToGemini } from './adapters/gemini.js';
import { exportToCursor } from './adapters/cursor.js';
import { install } from './install.js';
import { validate } from './validate.js';
import { watch } from './watch.js';
import { FORMAT_SOURCES } from './watch-sources.js';
import { sync, resolveAdapters, writeAdapters, machineAdaptersPath, KNOWN_ADAPTERS, knownAdapters } from './sync.js';
import { runKnowledgeHook } from './knowledge-hook.js';
import { removeSessionHook, KNOWLEDGE_HOOK } from './hooks.js';
import { collectKnowledgeMetadata, knowledgeHookEnabled, lintKnowledge } from './knowledge.js';
import { init } from './init.js';
import { resolve } from 'node:path';
// Status/logs go to stderr; only generated content goes to stdout. This is the
// deliberate fix for the upstream bug that leaked log lines into CLAUDE.md.
function getOpt(long, short) {
    const i = process.argv.findIndex((a) => a === long || (short && a === short));
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag) => process.argv.includes(flag);
// Taken by every command, so they are declared once rather than in all eight.
const GLOBAL_FLAGS = {
    '--dir': 'value',
    '-d': 'value',
    '--help': 'bare',
    '-h': 'bare',
};
const COMMANDS = {
    init: {
        usage: 'agentdef init [--no-sync] [--dir .]',
        summary: 'install the git hooks and run the first sync (the whole one-time setup)',
        detail: ['--no-sync    install the hooks only, skip the initial sync'],
        flags: { '--no-sync': 'bare' },
    },
    sync: {
        usage: 'agentdef sync [--adapters a,b,c] [--force] [--dir .]',
        summary: 'regenerate the instruction files for every configured tool',
        detail: [
            '--adapters   comma-separated tools for this run, overriding .agent-adapters',
            '--force      regenerate even when no source changed',
        ],
        flags: { '--adapters': 'value', '--force': 'bare' },
    },
    adapters: {
        usage: 'agentdef adapters [list | show | set [--local] <tool>...] [--dir .]',
        summary: 'inspect or choose which tools sync generates for',
        detail: [
            'list         every adapter agentdef knows, and what each one writes',
            'show         the adapters in effect here and where they come from (default)',
            'set          write the adapter list; --local writes it into this repo',
        ],
        flags: { '--local': 'bare' },
    },
    export: {
        usage: 'agentdef export --format <format> [--out FILE] [--dir .]',
        summary: "print one tool's instruction file to stdout",
        detail: [
            '--format     claude-code, agents, gemini, cursor, or an AGENTS.md alias:',
            '             codex, copilot, kiro, opencode, windsurf, zed, aider, kimi, grok, antigravity',
            '--out        write to FILE instead of stdout',
        ],
        flags: { '--format': 'value', '-f': 'value', '--out': 'value', '-o': 'value' },
    },
    install: {
        usage: 'agentdef install [--force] [--dir .]',
        summary: 'materialize the extends chain into .agentdef/parent',
        detail: ['--force      re-clone every ancestor even when the cache is current'],
        flags: { '--force': 'bare' },
    },
    validate: {
        usage: 'agentdef validate [--dir .]',
        summary: 'check agent.yaml, skills and knowledge docs; exits 1 on any error',
    },
    watch: {
        usage: 'agentdef watch [--baseline FILE] [--update] [--dir .]',
        summary: "fingerprint each tool's published format and report drift",
        detail: [
            '--baseline   baseline file (default: watch-baselines.json in --dir)',
            '--update     record the current fingerprints instead of failing on drift',
        ],
        flags: { '--baseline': 'value', '--update': 'bare' },
    },
    knowledge: {
        usage: 'agentdef knowledge <hook|unhook|lint> [<claude|gemini>] [--fix] [--dir .]',
        summary: 'lint the knowledge docs, or manage the SessionStart hook that injects the index',
        detail: [
            'lint         report local knowledge docs that are missing OKF frontmatter',
            '--fix        write the inferred frontmatter instead of only reporting it',
            'hook|unhook  register or remove the SessionStart hook for claude or gemini',
        ],
        flags: { '--fix': 'bare' },
    },
};
function renderHelp(topic) {
    const cmd = topic ? COMMANDS[topic] : undefined;
    if (cmd) {
        return [
            cmd.summary,
            '',
            `usage: ${cmd.usage}`,
            '',
            ...(cmd.detail ?? []).map((d) => `  ${d}`),
            '  --dir, -d    the agent directory (default: the current one)',
        ].join('\n');
    }
    const width = Math.max(...Object.keys(COMMANDS).map((n) => n.length));
    return [
        'agentdef: define an agent once, generate the config file every tool expects.',
        '',
        'usage: agentdef <command> [options]',
        '',
        ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
        '',
        "run 'agentdef help <command>' or 'agentdef <command> --help' for one command's options.",
        'every command takes --dir, -d to point at an agent directory other than the current one.',
    ].join('\n');
}
// Every flag agentdef does not know used to be discarded without a word, which
// made a typo change what the command did rather than stop it: `-dir` fell back
// to the current directory, so sync and install operated on the wrong repo and
// reported success. So it refuses instead, before the command runs. A single-dash
// long flag (`-help`, `-dir`, `-force`) is the slip people actually make, so it
// is named as such instead of leaving them to spot it in the usage text.
function rejectUnknownFlags(command, cmd) {
    const accepted = { ...GLOBAL_FLAGS, ...cmd.flags };
    const argv = process.argv.slice(3);
    const unknown = [];
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        // Positionals (subcommands, `help <topic>`, `adapters set <tool>...`) and a
        // bare `-`, which no command reads but which is never a typo'd flag either.
        if (!arg.startsWith('-') || arg === '-')
            continue;
        const arity = accepted[arg];
        if (arity) {
            // A value is whatever the user wrote, including something flag-shaped like
            // `--out -weird`; only the flag itself is ours to judge.
            if (arity === 'value')
                i++;
            continue;
        }
        const meant = !arg.startsWith('--') && accepted[`-${arg}`] ? `-${arg}` : undefined;
        unknown.push(meant ? `${arg} (did you mean ${meant}?)` : arg);
    }
    if (unknown.length === 0)
        return;
    // Every one at once: two typos should not cost two runs.
    for (const flag of unknown)
        console.error(`unknown flag: ${flag}`);
    console.error(`\n${renderHelp(command)}`);
    process.exit(1);
}
// Nudge users to update the globally installed CLI. update-notifier only prints
// on a TTY and to stderr, so it never shows in git hooks / pipes / CI and never
// pollutes `export > file` stdout. Best-effort: an update check must never break
// the actual command, so any failure here is swallowed.
function checkForUpdate() {
    try {
        const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        updateNotifier({ pkg }).notify({ isGlobal: true });
    }
    catch {
        // intentionally ignored: the update check is an optional convenience
    }
}
async function main() {
    const command = process.argv[2];
    const args = process.argv.slice(2);
    // Answered before dispatch, and before the update check, because every command
    // here runs for its side effects: init installs git hooks, rewrites .gitignore
    // and deletes the legacy cache; sync writes the generated files; install clones
    // the parent over the network. A check inside each case would leave the next
    // command added one forgotten line away from executing on `--help` again.
    if (command === 'help' || args.some((a) => a === '--help' || a === '-h')) {
        // Same positional rule the adapters/knowledge subcommands use: the topic is
        // the next bare word, so `agentdef help --dir x` is not read as a topic of
        // "x" and `agentdef --help` is not read as a topic of "--help".
        const positional = (i) => process.argv[i] && !process.argv[i].startsWith('-') ? process.argv[i] : undefined;
        const topic = command === 'help' ? positional(3) : positional(2);
        if (topic && !COMMANDS[topic]) {
            console.error(`unknown command: ${topic}\n`);
            console.error(renderHelp());
            process.exit(1);
        }
        // An explicit help request is not an error, so it exits 0 and goes to stdout
        // (`agentdef --help | less` has to work). This is the one carve-out from the
        // stdout rule above: help never runs alongside an export, so it cannot leak
        // into a generated file the way the upstream log lines did.
        process.stdout.write(`${renderHelp(topic)}\n`);
        return;
    }
    // Before the update check and the dispatch, for the same reason --help is:
    // the answer must arrive before the side effect. An unknown *command* is left
    // to the default branch below, which already reports it — there is no flag set
    // to check it against anyway. `knowledge` is not exempt: its --dir decides
    // which repo's knowledge index gets injected into a session.
    const help = COMMANDS[command];
    if (help)
        rejectUnknownFlags(command, help);
    // `knowledge hook` runs at every session start of the hook-mode tools: skip
    // the update check there — no spawned background process, zero latency, and
    // zero risk of anything but the payload reaching the tool.
    if (command !== 'knowledge')
        checkForUpdate();
    const dir = getOpt('--dir', '-d') ?? '.';
    switch (command) {
        case 'export': {
            const format = getOpt('--format', '-f');
            const out = getOpt('--out', '-o');
            let result;
            switch (format) {
                case 'claude-code':
                case 'claude':
                    result = exportToClaudeCode(dir);
                    break;
                // `agents` is the standard name. Every tool below reads AGENTS.md rather
                // than inventing its own format, so they are aliases for the same output.
                // This is the two-formats payoff: the long tail of tools comes free.
                case 'agents':
                case 'agents-md':
                case 'codex':
                case 'kimi':
                case 'grok':
                case 'antigravity':
                case 'windsurf':
                case 'opencode':
                case 'zed':
                case 'aider':
                case 'kiro':
                case 'copilot':
                    result = exportToAgentsMd(dir);
                    break;
                case 'gemini':
                    result = exportToGemini(dir);
                    break;
                case 'cursor':
                    result = exportToCursor(dir);
                    break;
                default:
                    console.error(`unknown or unsupported format: ${format ?? '(none)'}`);
                    process.exit(1);
            }
            if (out) {
                writeFileSync(out, result);
                console.error(`wrote ${out}`);
            }
            else {
                process.stdout.write(`${result}\n`);
            }
            break;
        }
        case 'install': {
            const res = install(dir, { mode: has('--force') ? 'force' : 'reuse' });
            console.error(res.installed.length ? `installed: ${res.installed.join(', ')}` : 'nothing to install (no extends)');
            for (const warning of res.warnings)
                console.error(warning);
            break;
        }
        case 'validate': {
            const issues = validate(dir);
            for (const issue of issues) {
                console.error(`${issue.level === 'error' ? 'ERROR' : 'warn '}: ${issue.message}`);
            }
            // Deduped: one remedy per distinct hint, after the list it applies to.
            for (const hint of new Set(issues.map((i) => i.hint).filter(Boolean))) {
                console.error(`hint : ${hint}`);
            }
            const errors = issues.filter((i) => i.level === 'error').length;
            if (errors > 0) {
                console.error(`validation failed: ${errors} error(s)`);
                process.exit(1);
            }
            console.error(`validation passed${issues.length ? ` (${issues.length} warning(s))` : ''}`);
            break;
        }
        case 'watch': {
            const baseline = getOpt('--baseline') ?? join(dir, 'watch-baselines.json');
            const res = await watch(FORMAT_SOURCES, baseline, { update: has('--update') });
            for (const n of res.added)
                console.error(`new    : ${n} (baseline recorded)`);
            for (const n of res.changed)
                console.error(`CHANGED: ${n} -> review and patch the adapter`);
            for (const n of res.unchanged)
                console.error(`ok     : ${n}`);
            if (res.changed.length > 0 && !has('--update')) {
                console.error(`drift detected in ${res.changed.length} source(s)`);
                process.exit(1);
            }
            break;
        }
        case 'sync': {
            const adaptersOpt = getOpt('--adapters');
            const res = sync(dir, {
                adapters: adaptersOpt ? adaptersOpt.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
                force: has('--force'),
            });
            console.error(`synced for: ${res.adapters.join(', ')}`);
            for (const w of res.written)
                console.error(`  ${w}`);
            for (const warning of res.warnings)
                console.error(warning);
            break;
        }
        case 'adapters': {
            // Subcommand is the first positional after `adapters`; a flag like --dir
            // is not a subcommand, so bare `agentdef adapters --dir X` still shows.
            const sub = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : undefined;
            const knownList = [...KNOWN_ADAPTERS].sort().join(', ');
            if (sub === 'set') {
                // Positional tools after `set`, ignoring flags and the --dir/-d value.
                const raw = process.argv.slice(4);
                const tools = [];
                for (let i = 0; i < raw.length; i++) {
                    const a = raw[i];
                    if (a === '--dir' || a === '-d') {
                        i++;
                        continue;
                    }
                    if (a.startsWith('-'))
                        continue;
                    tools.push(a);
                }
                if (tools.length === 0) {
                    console.error('usage: agentdef adapters set [--local] <tool> [tool...]');
                    process.exit(1);
                }
                const { path, unknown } = writeAdapters(tools, { local: has('--local'), dir });
                console.error(`wrote ${tools.join(', ')} to ${path}`);
                if (unknown.length) {
                    console.error(`warning: unknown adapter(s): ${unknown.join(', ')} (agentdef generates nothing for these). known: ${knownList}`);
                }
                console.error(has('--local')
                    ? 'this repo uses these on the next sync'
                    : 'repos without a per-repo .agent-adapters use these on the next sync');
            }
            else if (sub === 'list') {
                console.error('known adapters (set with: agentdef adapters set <name>...):');
                for (const a of knownAdapters()) {
                    console.error(`  ${a.name.padEnd(13)} ${a.instruction.padEnd(34)} ${a.skills.padEnd(18)} knowledge: ${a.knowledge}`);
                }
            }
            else if (!sub || sub === 'show') {
                const r = resolveAdapters(resolve(dir));
                if (r.source === 'none') {
                    // Exit non-zero so scripts (e.g. bootstrap) can gate on "configured?".
                    console.error(`no adapters set. Run 'agentdef adapters set <tool> [tool...]' (writes ${machineAdaptersPath()}). known: ${knownList}`);
                    process.exit(1);
                }
                const label = r.source === 'repo' ? 'this repo' : r.source === 'machine' ? 'machine default' : r.source;
                console.error(`adapters: ${r.adapters.join(', ')}`);
                console.error(`source:   ${r.path} (${label})`);
            }
            else {
                console.error('usage: agentdef adapters [list | show | set [--local] <tool>...]');
                process.exit(1);
            }
            break;
        }
        // The `agentdef knowledge hook <tool>` string is a permanent API contract:
        // sync bakes it into user settings files (.claude/settings.json,
        // .gemini/settings.json — see hooks.ts) and stale entries are left in place
        // by design, so it must keep working forever. Never rename it.
        case 'knowledge': {
            const sub = process.argv[3] && !process.argv[3].startsWith('-') ? process.argv[3] : undefined;
            const usage = 'usage: agentdef knowledge <hook|unhook|lint> [<claude|gemini>] [--fix] [--dir .]';
            if (sub === 'lint') {
                const fix = has('--fix');
                const { findings, fixed } = lintKnowledge(dir, { fix });
                const missing = findings.filter((f) => f.reason === 'missing-frontmatter');
                const malformed = findings.filter((f) => f.reason === 'malformed-frontmatter');
                for (const f of missing) {
                    const p = `${f.proposed?.type}, title: ${f.proposed?.title}`;
                    console.error(fix ? `fixed  : ${f.relPath} (type: ${p})` : `missing: ${f.relPath} -> would add type: ${p}`);
                }
                for (const f of malformed)
                    console.error(`broken : ${f.detail}`);
                if (findings.length === 0) {
                    console.error('all knowledge docs carry OKF frontmatter');
                    break;
                }
                if (fixed.length) {
                    console.error(`\n${fixed.length} document(s) updated. The type and title above are inferred from the`);
                    console.error('folder name and the first heading, so review them before committing.');
                }
                // Malformed frontmatter is never auto-repaired, so it must keep the exit
                // non-zero even after --fix, or CI would go green on a still-broken repo.
                if (malformed.length) {
                    console.error(`\n${malformed.length} document(s) have frontmatter but no usable 'type'. Fix those by hand.`);
                    process.exit(1);
                }
                if (!fix)
                    process.exit(1);
                break;
            }
            if (sub !== 'hook' && sub !== 'unhook') {
                console.error(usage);
                process.exit(1);
            }
            const tool = process.argv[4] && !process.argv[4].startsWith('-') ? process.argv[4] : undefined;
            if (tool !== 'claude' && tool !== 'gemini') {
                if (sub === 'unhook') {
                    // Interactive command, so a bad tool name may fail loudly.
                    console.error(usage);
                    process.exit(1);
                }
                // hook: an unknown tool means a stale or hand-edited settings entry; a
                // session start must never break over it, so warn on stderr and exit 0.
                console.error(`agentdef knowledge hook: unknown tool "${tool ?? '(none)'}" (expected claude or gemini)`);
                break;
            }
            if (sub === 'unhook') {
                const agentDir = resolve(dir);
                const target = KNOWLEDGE_HOOK[tool === 'claude' ? 'claude-code' : 'gemini'];
                const r = removeSessionHook(agentDir, target);
                for (const warning of r.warnings)
                    console.error(warning);
                console.error(r.changed ? `removed the knowledge hook from ${target.settingsFile}` : `no knowledge hook registered in ${target.settingsFile}`);
                if (r.changed && knowledgeHookEnabled(agentDir) && collectKnowledgeMetadata(agentDir).entries.length > 0) {
                    console.error('note: knowledge exists and hooks are enabled, so the next sync re-registers it. Set knowledge: { hook: false } in agent.yaml to keep it off (the instruction file then carries the full index).');
                }
                break;
            }
            const out = runKnowledgeHook(dir, tool);
            for (const line of out.stderr)
                console.error(line);
            if (out.stdout)
                process.stdout.write(out.stdout);
            break;
        }
        case 'init': {
            const res = init(dir);
            console.error(`installed hooks in ${res.hooksDir}: ${res.installed.join(', ')}`);
            if (res.unsetHooksPath)
                console.error('unset core.hooksPath so the installed hooks run');
            if (res.externalHooksPath) {
                console.error(`warning: core.hooksPath is set outside this repo (${res.externalHooksPath}); git runs that directory, not the hooks just installed. Clear it with 'git config --global --unset core.hooksPath'.`);
            }
            if (res.gitignoreAdded)
                console.error('added .agentdef/ to .gitignore (regenerable cache, never commit it)');
            if (res.legacyRemoved)
                console.error('migrated: removed legacy .gitagent/ (untracked + deleted); commit the change');
            // First sync, so `agentdef init` is the entire one-time setup. --no-sync
            // opts out; a missing adapter list is a hint, not a failure (the hooks are
            // already installed, so sync can run later once adapters are chosen).
            if (!has('--no-sync')) {
                if (resolveAdapters(resolve(dir)).source === 'none') {
                    console.error("no adapters configured yet; run 'agentdef adapters set <tool>...' then 'agentdef sync'");
                }
                else {
                    const sres = sync(dir);
                    console.error(`synced for: ${sres.adapters.join(', ')}`);
                    for (const w of sres.written)
                        console.error(`  ${w}`);
                    for (const warning of sres.warnings)
                        console.error(warning);
                }
            }
            console.error('done. agentdef sync now runs automatically after commit/pull/merge/checkout/rebase.');
            break;
        }
        default:
            console.error(`unknown command: ${command ?? '(none)'}\n`);
            console.error(renderHelp());
            process.exit(1);
    }
}
// No user-facing path may end in a raw stack trace with internal dist/ frames.
// Every throw in agentdef carries a complete, self-explanatory message (a bad
// agent.yaml, an extends cycle, an unreadable parent), so one line is the whole
// diagnosis; the stack only ever named files the user cannot act on.
main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
});
