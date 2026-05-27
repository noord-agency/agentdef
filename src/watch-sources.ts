import type { WatchSource } from './watch.js';

// Format sources to monitor for drift. Prefer raw, stable artifacts (spec files,
// docs pages) over rendered marketing pages. Curate these to the canonical
// source for each format you emit. A change here means a tool may have altered
// what it expects, review and, if needed, patch the matching adapter.
export const FORMAT_SOURCES: WatchSource[] = [
  {
    name: 'agents-md-spec',
    url: 'https://raw.githubusercontent.com/openai/agents.md/main/README.md',
  },
  {
    name: 'claude-code-memory-docs',
    url: 'https://docs.claude.com/en/docs/claude-code/memory.md',
  },
  {
    name: 'cursor-rules-docs',
    url: 'https://docs.cursor.com/context/rules.md',
  },
  // Model-lab CLIs read AGENTS.md, but watch their own docs too in case any adds
  // tool-specific behavior on top of the standard.
  {
    name: 'kimi-cli-skills-docs',
    url: 'https://moonshotai.github.io/kimi-cli/en/customization/skills.html',
  },
  {
    name: 'grok-build-instructions-docs',
    url: 'https://deepwiki.com/superagent-ai/grok-cli/7.3-custom-instructions',
  },
];
