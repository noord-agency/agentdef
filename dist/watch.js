import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
async function fetchSource(url) {
    if (url.startsWith('file:')) {
        return readFileSync(url.slice('file:'.length), 'utf-8');
    }
    const res = await fetch(url);
    if (!res.ok) {
        // Fail loud: a source we cannot read is a real problem, not a silent skip.
        throw new Error(`watch: fetch ${url} failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
}
function fingerprint(text) {
    const normalized = text.replace(/\r\n/g, '\n').trim();
    return createHash('sha256').update(normalized).digest('hex');
}
// Compare each watched format source against a stored baseline of fingerprints.
// Deterministic, no LLM, no API key: any content change is reported for human
// review. (An optional LLM noise-filter could later judge relevance; it is the
// only piece that would need a key, and only as a CI secret.)
export async function watch(sources, baselinePath, opts = {}) {
    const baselines = existsSync(baselinePath)
        ? JSON.parse(readFileSync(baselinePath, 'utf-8'))
        : {};
    const result = { added: [], changed: [], unchanged: [] };
    const next = { ...baselines };
    for (const source of sources) {
        const current = fingerprint(await fetchSource(source.url));
        const previous = baselines[source.name];
        if (previous === undefined)
            result.added.push(source.name);
        else if (previous !== current)
            result.changed.push(source.name);
        else
            result.unchanged.push(source.name);
        next[source.name] = current;
    }
    if (opts.update) {
        writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
    }
    return result;
}
