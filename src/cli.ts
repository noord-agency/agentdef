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
import { init } from './init.js';
import { resolve } from 'node:path';

// Status/logs go to stderr; only generated content goes to stdout. This is the
// deliberate fix for the upstream bug that leaked log lines into CLAUDE.md.
function getOpt(long: string, short?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === long || (short && a === short));
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

// Nudge users to update the globally installed CLI. update-notifier only prints
// on a TTY and to stderr, so it never shows in git hooks / pipes / CI and never
// pollutes `export > file` stdout. Best-effort: an update check must never break
// the actual command, so any failure here is swallowed.
function checkForUpdate(): void {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name: string; version: string };
    updateNotifier({ pkg }).notify({ isGlobal: true });
  } catch {
    // intentionally ignored: the update check is an optional convenience
  }
}

async function main(): Promise<void> {
  checkForUpdate();
  const command = process.argv[2];
  const dir = getOpt('--dir', '-d') ?? '.';

  switch (command) {
    case 'export': {
      const format = getOpt('--format', '-f');
      const out = getOpt('--out', '-o');
      let result: string;
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
      } else {
        process.stdout.write(`${result}\n`);
      }
      break;
    }

    case 'install': {
      const res = install(dir, { force: has('--force') });
      console.error(res.installed.length ? `installed: ${res.installed.join(', ')}` : 'nothing to install (no extends)');
      break;
    }

    case 'validate': {
      const issues = validate(dir);
      for (const issue of issues) {
        console.error(`${issue.level === 'error' ? 'ERROR' : 'warn '}: ${issue.message}`);
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
      for (const n of res.added) console.error(`new    : ${n} (baseline recorded)`);
      for (const n of res.changed) console.error(`CHANGED: ${n} -> review and patch the adapter`);
      for (const n of res.unchanged) console.error(`ok     : ${n}`);
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
      });
      console.error(`synced for: ${res.adapters.join(', ')}`);
      for (const w of res.written) console.error(`  ${w}`);
      for (const warning of res.warnings) console.error(warning);
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
        const tools: string[] = [];
        for (let i = 0; i < raw.length; i++) {
          const a = raw[i];
          if (a === '--dir' || a === '-d') { i++; continue; }
          if (a.startsWith('-')) continue;
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
      } else if (sub === 'list') {
        console.error('known adapters (set with: agentdef adapters set <name>...):');
        for (const a of knownAdapters()) {
          console.error(`  ${a.name.padEnd(13)} ${a.instruction.padEnd(34)} ${a.skills}`);
        }
      } else if (!sub || sub === 'show') {
        const r = resolveAdapters(resolve(dir));
        if (r.source === 'none') {
          // Exit non-zero so scripts (e.g. bootstrap) can gate on "configured?".
          console.error(`no adapters set. Run 'agentdef adapters set <tool> [tool...]' (writes ${machineAdaptersPath()}). known: ${knownList}`);
          process.exit(1);
        }
        const label = r.source === 'repo' ? 'this repo' : r.source === 'machine' ? 'machine default' : r.source;
        console.error(`adapters: ${r.adapters.join(', ')}`);
        console.error(`source:   ${r.path} (${label})`);
      } else {
        console.error('usage: agentdef adapters [list | show | set [--local] <tool>...]');
        process.exit(1);
      }
      break;
    }

    case 'init': {
      const res = init(dir);
      console.error(`installed hooks in ${res.hooksDir}: ${res.installed.join(', ')}`);
      if (res.unsetHooksPath) console.error('unset core.hooksPath so the installed hooks run');
      if (res.gitignoreAdded) console.error('added .agentdef/ to .gitignore (regenerable cache, never commit it)');
      if (res.legacyRemoved) console.error('migrated: removed legacy .gitagent/ (untracked + deleted); commit the change');
      console.error('done. agentdef sync now runs automatically after pull/merge/checkout/rebase.');
      break;
    }

    default:
      console.error('usage: agentdef <init|sync|adapters|export|install|validate|watch> [--format <claude-code|agents|gemini|cursor>] [--adapters a,b,c] [--dir .] [--out FILE] [--force] [--update]');
      process.exit(1);
  }
}

main();
