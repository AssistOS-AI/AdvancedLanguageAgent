function skillLocation(name) {
  return `.agents/skills/${name}/SKILL.md`;
}

export function selectedSkillPrompt(skill, userPrompt) {
  return `Execute the user request with the Anthropic-style skill "${skill.name}".

Read ${skillLocation(skill.name)} again for this execution, even if you read it in an earlier turn, and follow its current instructions, constraints, examples, and acceptance conditions. Reread any helper or resource you use from that skill directory; do not reuse remembered contents. The skill owns the task methodology; return only the requested result.

User request:
${userPrompt}`;
}

export function catalogSelectionPrompt(_skills, userPrompt) {
  return `Task skills are mounted in .agents/skills. Read the relevant SKILL.md files and follow their instructions when applicable.

${userPrompt}`;
}
