import codex from './agents/codex/index.mjs';
import opencode from './agents/opencode/index.mjs';
import pi from './agents/pi/index.mjs';
import omp from './agents/omp/index.mjs';
import claude from './agents/claude/index.mjs';

// The single list of coding agents. Its order is the fixed report and `auto` fallback order.
export const AGENTS = Object.freeze([codex, opencode, pi, omp, claude]);
export const AGENT_NAMES = Object.freeze(AGENTS.map((agent) => agent.name));

const byName = new Map(AGENTS.map((agent) => [agent.name, agent]));

export function getAgent(name) {
  return byName.get(name) || null;
}

// "a, b, or c" by default; serial: false gives "a, b or c".
export function enumerate(items, { word = 'or', serial = true } = {}) {
  if (items.length < 2) return items.join('');
  if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}${serial ? ',' : ''} ${word} ${items.at(-1)}`;
}

export const agentChoices = () => AGENT_NAMES.join('|');

// The agents whose native policy has an approval flow, for messages that point a user to one.
export const approvalAgentLabels = () => enumerate(
  AGENTS.filter((agent) => agent.capabilities.approvals).map((agent) => agent.label), { serial: false }
);
