// The per-repo config, .github/ghx.json (brief decision 2026-10-22; 01 §5; 02 §15).
//
// Extension point: config keys live in src/config/sections/<section>.ts. Adding a key to an existing
// section edits only that section's file. A new top-level section is a new file plus ONE line here.
// Use .prefault(v), not .default(v): zod 4's .default returns v unparsed, so nested defaults would not fill.
import { z } from 'zod';
import { BotsSection } from './sections/bots.ts';
import { CiSection } from './sections/ci.ts';
import { ComponentsRecord, ComponentsSection } from './sections/components.ts';
import { CreateSection } from './sections/create.ts';
import { MergeSection } from './sections/merge.ts';
import { RenderSection } from './sections/render.ts';
import { TitleSection } from './sections/title.ts';
import { TrustSection } from './sections/trust.ts';

export const CONFIG_PATH = '.github/ghx.json';
export const CONFIG_VERSION = 1;

export const ConfigSchema = z.strictObject({
  $schema: z.string().optional(),
  version: z.literal(CONFIG_VERSION),
  components: ComponentsSection,
  title: TitleSection,
  render: RenderSection,
  create: CreateSection,
  merge: MergeSection,
  ci: CiSection,
  trust: TrustSection,
  bots: BotsSection,
});

export type GhxConfig = z.output<typeof ConfigSchema>;
export type GhxConfigInput = z.input<typeof ConfigSchema>;

/** The defaults used when the file is absent and the command's config need is 'optional'. */
export function defaultConfig(): GhxConfig {
  return ConfigSchema.extend({ components: ComponentsRecord.prefault({}) }).parse({ version: CONFIG_VERSION });
}
