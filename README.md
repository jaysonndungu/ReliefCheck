# ReliefCheck

Team 5's disaster relief evidence app for the Valencia DANA floods and Hurricane Melissa in Jamaica. The starter connects a React frontend to an Express API through a shared TypeScript contract.

## Get running

Install [Node.js 24 LTS](https://nodejs.org/en/download/) at version 24.22.2 or a later 24.x patch. Clone [the team repo](https://github.com/jaysonndungu/ReliefCheck), open a terminal in that folder, and run the setup command.

```sh
npm run setup
```

Open [localhost:5173](http://localhost:5173). The page should show **API connected**. Setup installs the locked dependencies and starts the web app and API. It works without an `.env`, database, Docker, or Gemini key. Use Ctrl+C to stop both servers. For later sessions run `npm run dev`. On Windows, use `npm.cmd run setup` if PowerShell blocks `npm.ps1`.

If port 5173 is occupied, free it and rerun setup. If port 3000 is occupied, copy `.env.example` to `.env`, set `PORT` to a free port, and restart. Keep server credentials in the ignored root `.env` or hosting secrets.

## Where to work

| Path | Responsibility |
| --- | --- |
| `apps/web` | React UI, Vite dev server and same-origin API calls |
| `apps/api` | Express API under `/api/v1` and production UI serving |
| `packages/contracts` | Shared Zod schemas and API paths |
| [ai.md](ai.md) | Story ownership, architecture, evidence rules and release checklist |
| [US05 source inventory](docs/us05-source-inventory.md) | Source candidates and review notes for both disasters |
| [US05 and US07 workflow](docs/us05-us07.md) | Manifest updates, preprocessing, tests, and the US06 adapter interface |

Run `npm run build` to type-check and build all three workspaces before opening a PR. To verify the production layout, stop the dev servers, run `npm run build` then `npm start`, and open [localhost:3000](http://localhost:3000). Both modes expose `GET /api/v1/health/live`. The separate `GET /api/v1/health/ready` returns 503 until database and reviewed corpus readiness are implemented.

Hosted setup, database migrations, staff accounts, and Gemini provider verification are follow-on work described in the design. The local starter does not access external providers or serve sample evidence.
