// The sanitized child environment for gh (01 §4.2): no pager, no prompts, no color, no update nags.
// Auth and host variables pass through untouched because gh owns auth.

export const GH_ENV_SET: Readonly<Record<string, string>> = {
  GH_PAGER: '',
  PAGER: 'cat',
  NO_COLOR: '1',
  CLICOLOR: '0',
  GH_PROMPT_DISABLED: '1',
  GH_NO_UPDATE_NOTIFIER: '1',
  GH_NO_EXTENSION_UPDATE_NOTIFIER: '1',
  GH_SPINNER_DISABLED: '1',
  GIT_TERMINAL_PROMPT: '0',
};

export const GH_ENV_DELETE: readonly string[] = ['GH_FORCE_TTY', 'CLICOLOR_FORCE', 'GH_DEBUG'];

export function buildGhEnv(
  base: Readonly<Record<string, string | undefined>>,
  o: { verbose?: boolean } = {},
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base };
  for (const k of GH_ENV_DELETE) {
    if (k === 'GH_DEBUG' && o.verbose) continue;
    delete env[k];
  }
  return { ...env, ...GH_ENV_SET };
}
