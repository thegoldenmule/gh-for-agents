#!/usr/bin/env node
// Entry point. A dev checkout runs src/main.ts (Node strips the types); the published package has no
// src/ and runs the compiled dist/main.js (Node refuses type stripping under node_modules). The Node
// version is checked before anything is imported, so an old Node gets a JSON error, not a syntax error.
const major = Number(process.versions.node.split('.')[0]);
if (major < 24) {
  const error = {
    code: 'ENV_NODE_UNSUPPORTED',
    message: `ghx needs Node.js 24 or newer; this is Node.js ${process.versions.node} (${process.execPath}).`,
    hint: 'Install Node.js 24+ (for example with nvm or fnm) and run ghx with it.',
    details: { node: process.versions.node, required: '>=24' },
  };
  process.stdout.write(`${JSON.stringify({ error })}\n`);
  process.exitCode = 4;
} else {
  const { existsSync } = await import('node:fs');
  const { enableCompileCache } = await import('node:module');
  enableCompileCache?.();
  const src = new URL('../src/main.ts', import.meta.url);
  await import(existsSync(src) ? src.href : new URL('../dist/main.js', import.meta.url).href);
}
