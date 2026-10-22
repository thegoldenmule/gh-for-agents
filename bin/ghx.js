#!/usr/bin/env node
import module from 'node:module';

module.enableCompileCache?.();
await import('../src/main.ts');
