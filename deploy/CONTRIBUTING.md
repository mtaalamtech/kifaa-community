# Contributing to Kifaa

Thank you for your interest in contributing! This document explains how to get involved.

## Ways to Contribute

- **Bug reports** — open an issue with steps to reproduce, expected vs actual behaviour, and your environment details
- **Feature requests** — open an issue describing the use case and why it belongs in the Community Edition
- **Pull requests** — bug fixes, improvements, new modules
- **Documentation** — corrections, clearer wording, new examples
- **Testing** — test on different OS/hardware combinations and report findings

## Development Setup

### Prerequisites

- Docker Engine 24+ and Docker Compose v2
- Go 1.21+ (for agent changes)
- Python 3.12+ (for server changes)
- Node 20+ (for frontend changes)

### Running locally

```bash
git clone https://github.com/kenyanut/kifaa.git
cd kifaa
cp .env.example .env
# Edit .env — set SERVER_IP to 127.0.0.1 for local dev
docker compose up -d
```

The stack starts in development mode with the server code volume-mounted, so Python changes take effect immediately (uvicorn reloads automatically). Frontend changes require a rebuild:

```bash
docker compose build frontend && docker compose up -d frontend
```

### Database migrations

Migrations are plain SQL scripts in `server/sql/migrations/`. Name them `NNNN_description.sql` (e.g. `0005_add_watchdog_events.sql`). The API applies them on startup.

## Pull Request Guidelines

1. **One thing per PR** — keep changes focused
2. **Test your change** — describe how you tested it in the PR description
3. **Follow existing style** — Python: PEP 8 / ruff, TypeScript: existing ESLint config, Go: `gofmt`
4. **No breaking changes to the API** — add new endpoints rather than changing existing ones
5. **Update documentation** — if you add a feature, update the relevant `docs/` file
6. **Signed-off commits** — include `Signed-off-by: Your Name <your@email.com>` in your commit message

## Code of Conduct

Be respectful. We're here to build good software together.

## Enterprise vs Community

Some features are reserved for the Enterprise Edition (AD integration, browser RDP, integrations, SIEM). Do not submit PRs that replicate Enterprise functionality — they will not be merged. Open an issue first if you're unsure whether your idea belongs in the Community Edition.

## Questions?

Open a GitHub Discussion or email [info@kenyanut.com](mailto:info@kenyanut.com).
