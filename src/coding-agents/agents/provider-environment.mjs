// The model-provider variables allowed into the sandbox of agents that can use any provider.
export const PROVIDER_ENVIRONMENT = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'OPENAI_ORGANIZATION', 'OPENAI_PROJECT', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY', 'XAI_API_KEY',
  'OPENROUTER_API_KEY', 'COHERE_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_REGION',
  'AWS_DEFAULT_REGION'
]);

// The allowed variables through which such an agent can authenticate without a stored login.
export const PROVIDER_CREDENTIALS = Object.freeze(PROVIDER_ENVIRONMENT
  .filter((name) => name.endsWith('_API_KEY') || name === 'AWS_ACCESS_KEY_ID'));
