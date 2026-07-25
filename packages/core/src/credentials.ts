/**
 * Environment handling for runs that execute on someone else's credentials.
 *
 * The Agent SDK spawns a subprocess and resolves credentials from its
 * environment, in a documented order: `ANTHROPIC_API_KEY`, then
 * `ANTHROPIC_AUTH_TOKEN`, then an OAuth profile on disk, then platform
 * variables. That resolution is convenient locally and dangerous on a server:
 * a hosted demo that simply spreads `process.env` and adds a visitor's key can
 * silently fall through to the operator's own credentials and bill them for a
 * stranger's run.
 *
 * `visitorEnv` closes that path by removing every credential source the SDK
 * would consider before setting the visitor's key.
 */

/**
 * Credential sources the SDK consults. Anything here must be cleared before a
 * run on a supplied key, or the run may authenticate as somebody else.
 */
export const CREDENTIAL_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_SERVICE_ACCOUNT_ID',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_IDENTITY_TOKEN',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'ANTHROPIC_WORKSPACE_ID',
  'ANTHROPIC_AWS_WORKSPACE_ID',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_USE_ANTHROPIC_AWS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

export class InvalidApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApiKeyError';
  }
}

/** Shape check only. Whether the key actually works is the API's business. */
export function assertApiKeyShape(apiKey: unknown): asserts apiKey is string {
  if (typeof apiKey !== 'string') {
    throw new InvalidApiKeyError('An API key is required.');
  }
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith('sk-ant-')) {
    throw new InvalidApiKeyError('An Anthropic API key starts with "sk-ant-".');
  }
  if (trimmed.length < 40 || trimmed.length > 400) {
    throw new InvalidApiKeyError('That does not look like a complete API key.');
  }
  if (/\s/.test(trimmed)) {
    throw new InvalidApiKeyError('The API key contains whitespace.');
  }
}

/**
 * Build the subprocess environment for a run on a supplied key.
 *
 * Every credential variable is deleted before the key is set, so the run can
 * only authenticate as the caller — never as the host.
 */
export function visitorEnv(
  apiKey: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...baseEnv };
  for (const name of CREDENTIAL_ENV_VARS) {
    delete env[name];
  }
  env.ANTHROPIC_API_KEY = apiKey.trim();
  return env;
}

/**
 * Remove anything key-shaped from text bound for a log or an error response.
 *
 * Keys reach this process through request bodies, so any path that echoes a
 * message back — an SDK error, a stack trace — is a potential leak.
 */
export function redactSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-***redacted***');
}
