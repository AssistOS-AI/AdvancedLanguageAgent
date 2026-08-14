import { readFile } from 'node:fs/promises';

const ROUTING_KEYS = new Set(['actions', 'objects', 'targets', 'modifiers', 'phrases', 'required', 'conflicts']);
const STOP_WORDS = new Set(['a', 'an', 'and', 'are', 'as', 'by', 'for', 'from', 'in', 'into', 'is', 'of', 'on', 'or', 'the', 'this', 'to', 'with']);
const STRUCTURAL_MARKERS = ['after', 'before', 'first', 'then', 'finally', 'next', 'and', 'or'];

function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

function listValue(value) {
  return String(value || '').split(/[,;|]/u).map((item) => normalize(item)).filter(Boolean);
}

function parseMetadata(text) {
  const lines = String(text || '').split(/\r?\n/u);
  const metadata = { actions: [], objects: [], targets: [], modifiers: [], phrases: [], required: [], conflicts: [] };
  let active = false;
  for (const line of lines) {
    if (/^##\s+symbolic routing\s*$/iu.test(line.trim())) { active = true; continue; }
    if (active && /^##\s+/u.test(line.trim())) break;
    if (!active) continue;
    const match = line.match(/^\s*(?:[-*]\s*)?([a-z]+)\s*:\s*(.+?)\s*$/iu);
    if (match && ROUTING_KEYS.has(match[1].toLowerCase())) metadata[match[1].toLowerCase()].push(...listValue(match[2]));
  }
  return metadata;
}

function extractRepresentation(instruction) {
  const normalized = normalize(instruction);
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  return {
    text: normalized,
    tokens,
    actions: tokens.filter((token) => /(?:ate|ify|ise|ize|ing|ed)$/u.test(token)),
    objects: tokens.filter((token) => !STOP_WORDS.has(token)),
    targets: tokens.filter((token) => ['english', 'romanian', 'french', 'german', 'json', 'html', 'markdown'].includes(token)),
    modifiers: tokens.filter((token) => ['fast', 'deep', 'verified', 'strict', 'complex', 'simple'].includes(token)),
    structuralMarkers: STRUCTURAL_MARKERS.filter((marker) => tokens.includes(marker)),
    relationships: normalized.match(/\b(?:after|before|then|finally)\b[^.?!]*/gu) || []
  };
}

function includesTerm(representation, term) {
  return representation.text.includes(term) || representation.tokens.includes(term);
}

function scoreRecord(record, metadata, representation) {
  const matched = { phrases: [], actions: [], objects: [], targets: [], modifiers: [], conflicts: [] };
  for (const key of ['phrases', 'actions', 'objects', 'targets', 'modifiers']) {
    for (const term of metadata[key]) {
      const matches = key === 'phrases'
        ? term.split(/\s+/u).every((word) => representation.tokens.includes(word))
        : includesTerm(representation, term);
      if (matches) matched[key].push(term);
    }
  }
  for (const term of metadata.conflicts) if (includesTerm(representation, term)) matched.conflicts.push(term);
  const requiredMissing = metadata.required.filter((term) => !includesTerm(representation, term));
  const score = matched.phrases.length * 4 + matched.actions.length * 2 + matched.objects.length * 2
    + matched.targets.length * 2 + matched.modifiers.length - matched.conflicts.length * 5 - requiredMissing.length * 3;
  const deterministic = matched.phrases.length > 0 || score >= 6;
  return { record, metadata, matched, requiredMissing, score, deterministic };
}

export async function createSymbolicRouter(records = []) {
  const entries = [];
  for (const record of records) {
    if (!record.filePath) continue;
    try {
      const metadata = parseMetadata(await readFile(record.filePath, 'utf8'));
      if (Object.values(metadata).some((values) => values.length > 0)) entries.push({ record, metadata });
    } catch {}
  }
  return {
    route(instruction) {
      const representation = extractRepresentation(instruction);
      const scored = entries.map(({ record, metadata }) => scoreRecord(record, metadata, representation))
        .filter((candidate) => candidate.score > 0)
        .sort((left, right) => right.score - left.score);
      if (scored.length === 0) return { state: 'UNKNOWN', representation, skill: null };
      const top = scored[0];
      const tied = scored.filter((candidate) => candidate.score === top.score);
      if (tied.length > 1) return { state: 'AMBIGUOUS', representation, skill: null, candidates: tied.map((item) => item.record.name) };
      if (top.deterministic) return { state: 'DETERMINISTIC', representation, skill: top.record.name };
      if (top.score >= 3 && (scored.length === 1 || top.score - scored[1].score >= 2)) {
        return { state: 'HIGH', representation, skill: top.record.name };
      }
      return { state: 'AMBIGUOUS', representation, skill: null, candidates: scored.map((item) => item.record.name) };
    },
    size: entries.length
  };
}

export { extractRepresentation, parseMetadata };
