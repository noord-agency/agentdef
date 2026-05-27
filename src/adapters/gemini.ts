import { buildInstructionDoc } from '../doc.js';

// GEMINI.md: same shape as AGENTS.md plus a delegation (sub-agents) section and
// an optional memory section, which Gemini CLI documents inline. The runtime
// .gemini/settings.json the upstream tool also emitted is not generated: model
// endpoint, hooks, and MCP config are per-machine, not derived from source.
export function exportToGemini(dir: string): string {
  return buildInstructionDoc(dir, { delegation: true, memory: true });
}
