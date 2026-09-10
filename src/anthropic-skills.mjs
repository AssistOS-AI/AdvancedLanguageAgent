function skillLocation(name) {
  return `.agents/skills/${name}/SKILL.md`;
}

export function selectedSkillPrompt(skill, userPrompt) {
  return `Execute the user request with the Anthropic-style skill "${skill.name}".

Read ${skillLocation(skill.name)} again for this execution, even if you read it in an earlier turn, and follow its current instructions, constraints, examples, and acceptance conditions. Reread any helper or resource you use from that skill directory; do not reuse remembered contents. The skill owns the task methodology; return only the requested result.

User request:
${userPrompt}`;
}

export function catalogSelectionPrompt(skills, userPrompt, envelope = null) {
  const catalog = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n');
  return `Complete the user request using the available Anthropic-style task skills when one clearly applies.

Current execution catalog${envelope ? `: ${JSON.stringify({ version: envelope.version,
    revision: envelope.revision, policyVersion: envelope.policyVersion, entries: envelope.entries,
    diagnostics: envelope.diagnostics })}` : ''}.
This is the complete current selection and supersedes earlier catalog messages in this conversation. Skills absent from this list are unavailable for this execution, including previously used or remembered skills. Do not use other discovered skills or earlier skill instructions. Keep the conversation's ordinary history and task context.

Available skills:
${catalog || '(none; no task skills are selected for this execution)'}

Select the best matching listed skill, read its descriptor at .agents/skills/<name>/SKILL.md again for this execution even if previously read, and follow its current instructions and resources. Reread every helper or asset you use; never rely on remembered contents from an earlier execution. If no skill applies, handle the request normally. Do not claim to have used a skill unless you read its current SKILL.md.

User request:
${userPrompt}`;
}
