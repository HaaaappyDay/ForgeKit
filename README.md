# ForgeKit

ForgeKit is a local CLI for running role-based agent workflows. It initializes a
`.forgekit/` workspace, routes tasks through configured roles and adapters,
stores every run artifact, and gives you CLI/TUI tools to inspect or retry runs.

## Quick Start

```bash
npm run build
node dist/cli.js init --template feature-planning --yes
node dist/cli.js adapter probe codex-local
node dist/cli.js workflow start --input "Plan a small settings export feature" --yes
```

Use `npm link` after building if you want the local `forge` command:

```bash
npm run build
npm link
forge --help
```

## Common Workflow

1. Initialize project config:

```bash
forge init --template feature-planning --project-name my-project --yes
```

2. Check external agent CLIs:

```bash
forge adapter probe codex-local
forge adapter probe claude-code
```

If an adapter command is not found, set it explicitly:

```bash
forge adapter set-command codex-local /path/to/codex
forge adapter probe codex-local
```

3. Start the default workflow:

```bash
forge workflow start --input "Describe the task" --yes
```

4. Inspect the run:

```bash
forge history
forge run show <run-id>
forge tui <run-id>
```

Run summaries are written to:

```text
.forgekit/runs/<run-id>/summary.md
```

## TUI

```bash
forge tui
```

The terminal dashboard can initialize a project, start runs, probe adapters,
view config, browse history, monitor live runs, and open run artifacts.

## Documentation

The full usage guide is in [docs/usage-guide.md](docs/usage-guide.md).

ForgeKit targets Node.js `>=20` and currently has no runtime dependencies.
