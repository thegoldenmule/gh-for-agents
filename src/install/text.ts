// A file's byte-level style that ghx keeps when it edits settings.json or CLAUDE.md: a UTF-8 BOM and
// CRLF line endings. Edits run on the plain text (no BOM, LF) and the style is put back afterwards.

export interface TextStyle {
  bom: boolean;
  crlf: boolean;
}

const BOM = '﻿';

export function styleOf(text: string | null): TextStyle {
  return { bom: text?.startsWith(BOM) ?? false, crlf: text?.includes('\r\n') ?? false };
}

/** Without the BOM, and with CRLF as LF. */
export function toPlain(text: string): string {
  const t = text.startsWith(BOM) ? text.slice(1) : text;
  return t.replaceAll('\r\n', '\n');
}

export function withStyle(text: string, style: TextStyle): string {
  const t = style.crlf ? text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') : text;
  return style.bom ? BOM + t : t;
}

/** Whether editing `text` in its own style can keep its bytes (false for mixed line endings). */
export function styleKeepsBytes(text: string): boolean {
  return withStyle(toPlain(text), styleOf(text)) === text;
}

/** The INSTALL_REFORMATTED warning for a file ghx had to rewrite in its own formatting. */
export function reformattedWarning(path: string, undo = true): { code: string; message: string } {
  const after = undo
    ? 'The original is in the backup, and ghx uninstall puts it back byte for byte while the file is unchanged.'
    : 'The file as it was is in the backup.';
  return {
    code: 'INSTALL_REFORMATTED',
    message: `${path} has formatting ghx can't keep (hand-wrapped JSON or mixed line endings), so the rewrite reformats it. ${after}`,
  };
}
