import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { install } from './install.js';
import { validate } from './validate.js';
import { exportToClaudeCode } from './adapters/claude-code.js';
import { exportToAgentsMd } from './adapters/agents-md.js';
import { exportToGemini } from './adapters/gemini.js';
import { exportToCursorFiles } from './adapters/cursor.js';
import { mirrorSkillDirs, mirrorAgentFiles } from './mirror.js';
import { LEGACY_AGENTDEF_DIR } from './paths.js';

// Where each tool reads its skills / sub-agents from.
const SKILL_DIR: Record<string, string> = {
  'claude-code': '.claude/skills',
  claude: '.claude/skills',
  cursor: '.cursor/skills',
  agents: '.agents/skills',
  codex: '.agents/skills',
  antigravity: '.agents/skills',
  gemini: '.gemini/skills',
  opencode: '.opencode/skills',
  kiro: '.kiro/skills',
  copilot: '.github/skills',
};
const AGENT_DIR: Record<string, string> = {
  'claude-code': '.claude/agents',
  claude: '.claude/agents',
  agents: '.agents/agents',
  codex: '.agents/agents',
  antigravity: '.agents/agents',
  copilot: '.github/agents',
};

function readAdapters(agentDir: string, override?: string[]): string[] {
  if (override && override.length) return override;
  const file = join(agentDir, '.agent-adapters');
  if (!existsSync(file)) {
    throw new Error('.agent-adapters not found. List one tool per line, or pass --adapters a,b,c');
  }
  return readFileSync(file, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function writeOut(agentDir: string, rel: string, content: string): void {
  const path = join(agentDir, rel);
  mkdirSync(dirname(path), { recursive: true });
  // Ensure a trailing newline, matching what `export > file` produced.
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}

// Generate the instruction file(s) for one adapter. Returns the paths written.
function generateInstruction(adapter: string, agentDir: string): string[] {
  switch (adapter) {
    case 'claude-code':
    case 'claude':
      writeOut(agentDir, 'CLAUDE.md', exportToClaudeCode(agentDir));
      return ['CLAUDE.md'];
    case 'agents':
    case 'codex':
      writeOut(agentDir, 'AGENTS.md', exportToAgentsMd(agentDir));
      return ['AGENTS.md'];
    case 'gemini':
      writeOut(agentDir, 'GEMINI.md', exportToGemini(agentDir));
      return ['GEMINI.md'];
    case 'cursor': {
      rmSync(join(agentDir, '.cursor', 'rules'), { recursive: true, force: true });
      const files = exportToCursorFiles(agentDir);
      for (const f of files) writeOut(agentDir, f.path, f.content);
      return [`.cursor/rules/ (${files.length})`];
    }
    default:
      // Adapter with no instruction file of its own (skills-mirror only), or one
      // we do not generate a file for. Skill mirroring still applies below.
      return [];
  }
}

export interface SyncResult {
  adapters: string[];
  written: string[];
  warnings: string[];
}

// The orchestrator: read the adapter list, resolve extends, validate, then for
// each adapter generate its instruction file and mirror skills/agents into its
// tool dir. No sandbox needed: nothing here writes into committed source.
export function sync(dir: string, opts: { adapters?: string[] } = {}): SyncResult {
  const agentDir = resolve(dir);
  const adapters = readAdapters(agentDir, opts.adapters);
  if (adapters.length === 0) throw new Error('no adapters selected');

  // Migration nudge: the cache dir was renamed .gitagent -> .agentdef. A repo
  // that still carries the old one hasn't run the new `init` yet, so point the
  // way. Runs on every sync, including the auto-sync hooks, so it surfaces by
  // itself. (`agentdef init` does the actual untrack + delete.)
  const warnings: string[] = [];
  if (existsSync(join(agentDir, LEGACY_AGENTDEF_DIR))) {
    warnings.push(
      `warning: legacy ${LEGACY_AGENTDEF_DIR}/ found — run \`agentdef init\` to migrate to .agentdef/`,
    );
  }

  install(agentDir, { force: true });

  const errors = validate(agentDir).filter((i) => i.level === 'error');
  if (errors.length > 0) {
    throw new Error(`validation failed:\n  ${errors.map((e) => e.message).join('\n  ')}`);
  }

  const written: string[] = [];
  for (const adapter of adapters) {
    written.push(...generateInstruction(adapter, agentDir));

    const skillDir = SKILL_DIR[adapter];
    if (skillDir) {
      const n = mirrorSkillDirs(agentDir, skillDir);
      if (n > 0) written.push(`${skillDir} (${n} skills)`);
    }
    const agentTargetDir = AGENT_DIR[adapter];
    if (agentTargetDir) {
      const n = mirrorAgentFiles(agentDir, agentTargetDir);
      if (n > 0) written.push(`${agentTargetDir} (${n} agents)`);
    }
  }
  return { adapters, written, warnings };
}
