import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { install } from './install.js';
import { validate } from './validate.js';
import { exportToClaudeCode } from './adapters/claude-code.js';
import { exportToAgentsMd } from './adapters/agents-md.js';
import { exportToGemini } from './adapters/gemini.js';
import { exportToCursorFiles } from './adapters/cursor.js';
import { mirrorSkillDirs, mirrorAgentFiles } from './mirror.js';
import { LEGACY_AGENTDEF_DIR } from './paths.js';
// Where each tool reads its skills / sub-agents from.
const SKILL_DIR = {
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
const AGENT_DIR = {
    'claude-code': '.claude/agents',
    claude: '.claude/agents',
    agents: '.agents/agents',
    codex: '.agents/agents',
    antigravity: '.agents/agents',
    copilot: '.github/agents',
};
// The tools agentdef knows how to generate for. Single-sourced from SKILL_DIR
// so `adapters set` can warn on a typo instead of silently generating nothing.
export const KNOWN_ADAPTERS = new Set(Object.keys(SKILL_DIR));
// One tool per line; blank lines and `# ...` comments ignored. Shared by the
// per-repo file and the machine-level default so they parse identically.
function parseAdapterList(text) {
    return text
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
}
// Machine-level default adapter list: declare your tools ONCE per machine
// instead of in every repo. `.agent-adapters` answers "which AI tool does this
// developer use", a personal, per-machine fact, not repo content, so it does
// not flow through `extends`. The per-repo `.agent-adapters` always overrides
// this. Location: $AGENTDEF_ADAPTERS_FILE, else $XDG_CONFIG_HOME/agentdef/adapters,
// else ~/.config/agentdef/adapters.
export function machineAdaptersPath() {
    if (process.env.AGENTDEF_ADAPTERS_FILE)
        return process.env.AGENTDEF_ADAPTERS_FILE;
    const configHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    return join(configHome, 'agentdef', 'adapters');
}
// Resolve the adapter list without throwing, reporting where it came from.
// Order: --adapters flag, then the per-repo file (if it lists a tool), then the
// machine default. `agentDir` must already be resolved to an absolute path.
export function resolveAdapters(agentDir, override) {
    if (override && override.length)
        return { adapters: override, source: 'flag' };
    const local = join(agentDir, '.agent-adapters');
    if (existsSync(local)) {
        const list = parseAdapterList(readFileSync(local, 'utf-8'));
        if (list.length)
            return { adapters: list, source: 'repo', path: local };
    }
    const machine = machineAdaptersPath();
    if (existsSync(machine)) {
        const list = parseAdapterList(readFileSync(machine, 'utf-8'));
        if (list.length)
            return { adapters: list, source: 'machine', path: machine };
    }
    return { adapters: [], source: 'none' };
}
// Write an adapter list, either the per-repo file or the machine default.
// Returns the path written and any tool names agentdef does not recognise.
export function writeAdapters(tools, opts) {
    const unknown = tools.filter((t) => !KNOWN_ADAPTERS.has(t));
    const path = opts.local ? join(resolve(opts.dir), '.agent-adapters') : machineAdaptersPath();
    const header = opts.local
        ? '# Per-repo tools for agentdef sync (gitignored, this checkout only). One per line.\n'
        : '# Machine-level default tools for agentdef sync. One per line. A per-repo\n# .agent-adapters overrides this.\n';
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${header}${tools.join('\n')}\n`);
    return { path, unknown };
}
function readAdapters(agentDir, override) {
    const r = resolveAdapters(agentDir, override);
    if (r.adapters.length)
        return r.adapters;
    const hasLocal = existsSync(join(agentDir, '.agent-adapters'));
    const where = `Set a machine default with 'agentdef adapters set <tool>...' (${machineAdaptersPath()}), add a per-repo .agent-adapters, or pass --adapters a,b,c`;
    throw new Error(hasLocal
        ? `.agent-adapters has no active tools. ${where}`
        : `.agent-adapters not found. ${where}`);
}
function writeOut(agentDir, rel, content) {
    const path = join(agentDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    // Ensure a trailing newline, matching what `export > file` produced.
    writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}
// Generate the instruction file(s) for one adapter. Returns the paths written.
function generateInstruction(adapter, agentDir) {
    switch (adapter) {
        case 'claude-code':
        case 'claude':
            writeOut(agentDir, 'CLAUDE.md', exportToClaudeCode(agentDir));
            return ['CLAUDE.md'];
        // AGENTS.md is the shared standard. codex, opencode, antigravity and kiro
        // all read it (kiro additionally supports .kiro/steering, AGENTS.md is fine).
        case 'agents':
        case 'codex':
        case 'opencode':
        case 'antigravity':
        case 'kiro':
            writeOut(agentDir, 'AGENTS.md', exportToAgentsMd(agentDir));
            return ['AGENTS.md'];
        // GitHub Copilot does NOT use AGENTS.md as its repo instructions; its native
        // file is .github/copilot-instructions.md (same content).
        case 'copilot':
            writeOut(agentDir, '.github/copilot-instructions.md', exportToAgentsMd(agentDir));
            return ['.github/copilot-instructions.md'];
        case 'gemini':
            writeOut(agentDir, 'GEMINI.md', exportToGemini(agentDir));
            return ['GEMINI.md'];
        case 'cursor': {
            rmSync(join(agentDir, '.cursor', 'rules'), { recursive: true, force: true });
            const files = exportToCursorFiles(agentDir);
            for (const f of files)
                writeOut(agentDir, f.path, f.content);
            return [`.cursor/rules/ (${files.length})`];
        }
        default:
            // Unknown adapter name (not one of the known tools). Skill mirroring still
            // applies below if it has a SKILL_DIR entry; no instruction file is written.
            return [];
    }
}
// Display label of the instruction file each adapter emits. Mirrors
// generateInstruction above; keep the two in sync.
const INSTRUCTION_FILE = {
    'claude-code': 'CLAUDE.md',
    claude: 'CLAUDE.md',
    agents: 'AGENTS.md',
    codex: 'AGENTS.md',
    opencode: 'AGENTS.md',
    antigravity: 'AGENTS.md',
    kiro: 'AGENTS.md',
    copilot: '.github/copilot-instructions.md',
    cursor: '.cursor/rules/',
    gemini: 'GEMINI.md',
};
// Fixed display order for `agentdef adapters list`: claude family, the AGENTS.md
// family, then the tools with their own file.
const ADAPTER_ORDER = [
    'claude-code', 'claude',
    'codex', 'agents', 'opencode', 'antigravity', 'kiro',
    'copilot', 'cursor', 'gemini',
];
// The known adapters with what each generates, for `agentdef adapters list`.
export function knownAdapters() {
    return ADAPTER_ORDER.map((name) => ({
        name,
        instruction: INSTRUCTION_FILE[name] ?? '(skills only)',
        skills: SKILL_DIR[name] ? `${SKILL_DIR[name]}/` : '(none)',
    }));
}
// The orchestrator: read the adapter list, resolve extends, validate, then for
// each adapter generate its instruction file and mirror skills/agents into its
// tool dir. No sandbox needed: nothing here writes into committed source.
export function sync(dir, opts = {}) {
    const agentDir = resolve(dir);
    const adapters = readAdapters(agentDir, opts.adapters);
    if (adapters.length === 0)
        throw new Error('no adapters selected');
    // Migration nudge: the cache dir was renamed .gitagent -> .agentdef. A repo
    // that still carries the old one hasn't run the new `init` yet, so point the
    // way. Runs on every sync, including the auto-sync hooks, so it surfaces by
    // itself. (`agentdef init` does the actual untrack + delete.)
    const warnings = [];
    if (existsSync(join(agentDir, LEGACY_AGENTDEF_DIR))) {
        warnings.push(`warning: legacy ${LEGACY_AGENTDEF_DIR}/ found — run \`agentdef init\` to migrate to .agentdef/`);
    }
    install(agentDir, { force: true });
    const issues = validate(agentDir);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length > 0) {
        throw new Error(`validation failed:\n  ${errors.map((e) => e.message).join('\n  ')}`);
    }
    // Surface validate warnings here too: most users only ever run sync (via the
    // git hooks), so a warning that exists only in `agentdef validate` is invisible.
    for (const issue of issues) {
        if (issue.level === 'warning')
            warnings.push(`warning: ${issue.message}`);
    }
    const written = [];
    for (const adapter of adapters) {
        written.push(...generateInstruction(adapter, agentDir));
        const skillDir = SKILL_DIR[adapter];
        if (skillDir) {
            const n = mirrorSkillDirs(agentDir, skillDir);
            if (n > 0)
                written.push(`${skillDir} (${n} skills)`);
        }
        const agentTargetDir = AGENT_DIR[adapter];
        if (agentTargetDir) {
            const n = mirrorAgentFiles(agentDir, agentTargetDir);
            if (n > 0)
                written.push(`${agentTargetDir} (${n} agents)`);
        }
    }
    return { adapters, written, warnings };
}
