export async function action(args) {
  const service = args.context?.codingAgentService;
  if (!service || typeof service.execute !== 'function') {
    throw new Error('ALA coding-agent service is unavailable.');
  }
  return service.execute(args.promptText, {
    agent: args.context?.codingAgentPreference || 'auto',
    signal: args.signal
  });
}
