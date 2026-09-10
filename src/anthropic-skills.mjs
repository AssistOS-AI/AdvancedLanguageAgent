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
  return `Use the skills in .agents/skills for the user's task. Read the relevant SKILL.md files again for this execution even if previously read, and follow their current instructions.

The currently mounted .agents/skills directory is the complete current selection and supersedes earlier catalog messages in this conversation. Skills absent from this directory are unavailable for this execution, including previously used or remembered skills. If the directory is empty, no task skills are selected for this execution. Keep the conversation's ordinary history and task context.

Reread every helper or asset you use from the current skill directory; never rely on remembered contents from an earlier execution. If no skill applies, handle the request normally. Do not claim to have used a skill unless you read its current SKILL.md.

User request:
${userPrompt}`;
}
