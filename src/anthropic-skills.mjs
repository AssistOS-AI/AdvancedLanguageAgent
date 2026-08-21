function skillLocation(name) {
  return `.agents/skills/${name}/SKILL.md`;
}

export function selectedSkillPrompt(skill, userPrompt) {
  return `Execute the user request with the Anthropic-style skill "${skill.name}".

Read ${skillLocation(skill.name)} and follow its instructions, constraints, examples, and acceptance conditions. Resolve any relative resource paths from that skill directory. The skill owns the task methodology; return only the requested result.

User request:
${userPrompt}`;
}

export function catalogSelectionPrompt(skills, userPrompt) {
  const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
  return `Complete the user request using the available Anthropic-style task skills when one clearly applies.

Available skills:
${catalog}

Select the best matching skill, read its descriptor at .agents/skills/<name>/SKILL.md, and follow its instructions and resources. If no skill applies, handle the request normally. Do not claim to have used a skill unless you read its SKILL.md.

User request:
${userPrompt}`;
}
