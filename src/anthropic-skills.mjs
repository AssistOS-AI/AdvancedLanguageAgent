function skillLocation(name) {
  return `.agents/skills/${name}/SKILL.md`;
}

export function selectedSkillPrompt(skill, userPrompt) {
  return `Execute the user request with the Anthropic-style skill "${skill.name}".

Read ${skillLocation(skill.name)} and follow its instructions, constraints, examples, and acceptance conditions. Resolve any relative resource paths from that skill directory. The skill owns the task methodology; return only the requested result.

User request:
${userPrompt}`;
}

export function catalogSelectionPrompt(_skills, userPrompt) {
  return `Use the skills in .agents/skills for the user's task. Read the relevant SKILL.md files and follow their instructions.

User request:
${userPrompt}`;
}
