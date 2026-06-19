# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the ForgeKit CLI and domain modules. `src/cli.ts` is the `forge` source entry point and compiles to `dist/cli.js`; command handlers use `*-command.ts`, shared helpers are plain modules, and adapter code lives in `src/adapters/`. `schemas/` holds versioned JSON schemas. `tests/` contains Node test runner suites, with reusable JSON examples in `tests/fixtures/valid/` and `tests/fixtures/invalid/`. `docs/` and `spikes/` hold design notes, acceptance notes, and experiments. There is no separate asset directory today.

## Build, Test, and Development Commands

- `npm test`: compile test output, then run the full suite with `node --test`.
- `npm run schema:list`: print registered schema IDs and backing files.
- `npm run build`: compile production TypeScript to `dist/`.
- `npm run typecheck`: type-check source and tests without emitting files.
- `npm run build && node dist/cli.js --help`: inspect local CLI commands.
- `npm run build && node dist/cli.js schema validate forgekit.workflow.v1 tests/fixtures/valid/workflow-feature-planning.json`: validate JSON against a registered schema.

The project targets Node.js `>=20` and currently has no runtime dependencies.

## Coding Style & Naming Conventions

Use native ES modules with `import`/`export`; import Node built-ins through `node:` specifiers. TypeScript source should keep `.js` import specifiers so emitted Node ESM resolves correctly. Match the existing style: 2-space indentation, double quotes, semicolons, and concise helper functions. Use `camelCase` for functions and variables. Keep filenames lowercase and hyphenated, such as `workflow-start-command.ts`; test files should end in `.test.ts`.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Add new tests under `tests/` near related behavior, and use temporary directories for filesystem mutations. Put reusable fixture JSON in `tests/fixtures/valid/` or `tests/fixtures/invalid/`. When changing schemas, update both the schema and fixture coverage. Run `npm test` before opening a PR. No formal coverage threshold is configured.

## Commit & Pull Request Guidelines

Recent commits use short, imperative, capitalized subjects, such as `Add workflow start run plan` and `Record MVP-0 acceptance gate`. Keep commits focused on one logical change. Pull requests should summarize behavior changes, list tests run, link related issues or docs, and include terminal output examples when command behavior changes.

## Security & Configuration Tips

Generated project state lives under `.forgekit/`. Do not commit `.forgekit/runs/`, `.forgekit/cache/`, `.forgekit/tmp/`, `.forgekit/secrets*`, `.env*`, `coverage/`, or `node_modules/`; these are already ignored. Keep adapter credentials and local environment values out of tracked fixtures and docs.
