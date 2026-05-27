import { buildInstructionDoc } from '../doc.js';
// AGENTS.md: the universal instruction file (Codex, Cursor, Kimi, Grok,
// Antigravity, Windsurf, Zed, ...). Skills inlined in full, since tools read it
// as a single file. The runtime codex.json the upstream tool also emitted is not
// generated: that is per-machine config, not derived from source.
export function exportToAgentsMd(dir) {
    return buildInstructionDoc(dir);
}
