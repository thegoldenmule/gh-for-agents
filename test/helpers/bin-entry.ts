// The entry of the --test-hooks binary (pnpm build:bin --test-hooks): ghx plus the test-only commands
// (test/helpers/commands, served only when GHX_TEST_HOOKS=1), so the contract suite's signal and exit
// tests can run against a compiled binary. Release binaries bundle src/main.ts alone, without these.
import { main } from '../../src/main.ts';
import { COMMANDS } from './commands.generated.ts';

await main(COMMANDS);
