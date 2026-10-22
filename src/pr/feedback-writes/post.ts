// Shared plumbing for the feedback writes (02 §7): the body cap and GitHub's own words for a rejection.
import { GhxError } from '../../core/errors.ts';
import { parseIncludeOutput } from '../../gh/api.ts';
import type { GhFailure } from '../../gh/index.ts';
import { MAX_BODY_CHARS } from '../../meta/codec.ts';

/** META_TOO_LARGE when a rendered body exceeds GitHub's 65,536-char cap (02 §9.1). */
export function assertBodySize(body: string, what: string): void {
  if (body.length <= MAX_BODY_CHARS) return;
  throw new GhxError(
    'META_TOO_LARGE',
    `The ${what} body with its ghx blocks is ${body.length} characters; GitHub allows ${MAX_BODY_CHARS}.`,
    { details: { chars: body.length, max: MAX_BODY_CHARS, what } },
  );
}

/** GitHub's message for a failed REST call: the body's errors[] (or message), else the status line. */
export function githubMessage(e: GhFailure): string {
  const body = e.result ? parseIncludeOutput(e.result.stdout).body : '';
  try {
    const j = JSON.parse(body) as { message?: string; errors?: (string | { message?: string; code?: string })[] };
    const parts = (j.errors ?? [])
      .map((x) => (typeof x === 'string' ? x : (x.message ?? x.code ?? '')))
      .filter((s) => s !== '');
    return parts.length > 0 ? parts.join('; ') : (j.message ?? e.message);
  } catch {
    return body.trim().slice(0, 300) || e.message;
  }
}
