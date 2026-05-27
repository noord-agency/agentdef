#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exportToClaudeCode } from './adapters/claude-code.js';
import { exportToAgentsMd } from './adapters/agents-md.js';
import { exportToGemini } from './adapters/gemini.js';
import { exportToCursor } from './adapters/cursor.js';
import { install } from './install.js';
import { validate } from './validate.js';
import { watch } from './watch.js';
import { FORMAT_SOURCES } from './watch-sources.js';
import { sync } from './sync.js';
import { init } from './init.js';

// Status/logs go to stderr; only generated content goes to stdout. This is the
// deliberate fix for the upstream bug that leaked log lines into CLAUDE.md.
function getOpt(long: string, short?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === long || (short && a === short));
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string) => process.argv.includes(flag);

async function main(): Promise<void> {
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
      break;
    }

    case 'init': {
      const res = init(dir);
      console.error(`installed hooks in ${res.hooksDir}: ${res.installed.join(', ')}`);
      if (res.unsetHooksPath) console.error('unset core.hooksPath so the installed hooks run');
      console.error('done. agentdef sync now runs automatically after pull/merge/checkout/rebase.');
      break;
    }

    default:
      console.error('usage: agentdef <init|sync|export|install|validate|watch> [--format <claude-code|agents|gemini|cursor>] [--adapters a,b,c] [--dir .] [--out FILE] [--force] [--update]');
      process.exit(1);
  }
}

main();
