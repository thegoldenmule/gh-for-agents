import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
/** The npm package name, as published. */
export const PACKAGE_NAME: string = pkg.name;
