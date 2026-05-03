# Wormhole

Worm-powered multi-agent orchestration on top of OpenAI. Instead of a single model call, Wormhole dispatches a pack of specialized worms that compete, attack, and review each other's outputs — then hands back the surviving answer as a content-addressed artifact.

```
   ∿∿∿∿∿∿∿∿∿∿∿∿
  ( ○          ○ )>
   ~~~~~~~~~~~~
```

## Roster

| Worm | Role |
|---|---|
| **Nightcrawler** | Worker. Cheap, high-temperature, dispatched in packs. |
| **Bloodworm** | Adversarial. Tries to break every candidate output. |
| **Silkworm** | Scavenger. Returns only the facts a task actually needs. |
| **Tapeworm** | Reviewer. Default-rejects. Returns a JSON verdict. |
| **Earthworm** | Heavyweight. Deep reasoning, called when the pack fails. |
| **Glowworm** | Carrier. Compresses and routes castings between Burrows. |

## Pipeline (the Tunnel)

```
  ┌──────────┐  facts  ┌─────────────┐  N parallel  ┌──────────────┐
  │ Silkworm │────────▶│ Nightcrawler│═════════════▶│ Nightcrawlers│
  │ (optional│         │   pack      │              │   output     │
  │  scan)   │         └─────────────┘              └──────┬───────┘
  └──────────┘                                             │
                                                           ▼
                                                  ┌─────────────────┐
                                                  │   Bloodworm     │
                                                  │   chaos pass    │
                                                  └────────┬────────┘
                                                           ▼
                                                  ┌─────────────────┐
                                                  │    Tapeworm     │
                                                  │     review      │
                                                  └────────┬────────┘
                                                           │
                                               any pass ───┴─── all fail
                                                   │               │
                                                   ▼               ▼
                                            ┌──────────┐   ┌───────────┐
                                            │  winner  │   │ Earthworm │
                                            │ castings │   │ fallback  │
                                            └──────────┘   └───────────┘
```

Every step writes castings to the Burrow with parent links to its inputs. A Tunnel is fully reconstructible from the Burrow alone.

## Concepts

- **Castings** — one worm invocation, content-addressed by `sha256(model || prompt || output)`.
- **Dig** — lightweight: Nightcrawler pack + Tapeworm arbitration.
- **Tunnel** — full pipeline: Silkworm → pack → Bloodworm → Tapeworm → Earthworm fallback.
- **Dirt** — file-backed store under `.wormhole/dirt/`.
- **Burrow** — per-project root, found by walking up from cwd.
- **Castings score** — reward signal: tapeworm score − cross-worm drift penalty + pass bonus, clamped 0..1.
- **Drift** — cross-worm word frequency. A Nightcrawler output mentioning *tapeworms* unprompted is the signal we measure.

## Install

```bash
git clone https://github.com/perturpe/wormhole.git
cd wormhole
npm install
npm run build
```

Requires Node.js 20+ and an OpenAI API key.

## Setup

```bash
export OPENAI_API_KEY=sk-your-key-here
node dist/cli.js init
```

## Usage

```bash
# Single worm — output streams as it arrives
node dist/cli.js wriggle silkworm --task "Summarize package.json"
node dist/cli.js wriggle bloodworm --task "Attack this regex: /^\d+$/"

# Scavenge context from files
node dist/cli.js scavenge --task "What does the build system do?" \
  --scan "package.json" --scan "src/**/*.ts"

# Quick dig (lightweight)
node dist/cli.js dig "Write a SQL join: users to last 5 orders" --pack 3

# Full tunnel with budget cap
node dist/cli.js tunnel "Refactor this module" \
  --pack 3 --scan "src/**/*.ts" \
  --budget 80000 --max-output 4096

# Reroll and compare
node dist/cli.js reroll <tunnelId>
node dist/cli.js compare <tunnelA> <tunnelB>

# Export / observe
node dist/cli.js export <tunnelId> --out result.md
node dist/cli.js drift
node dist/cli.js dirt --kind nightcrawler --since 2026-01-01 --limit 20
node dist/cli.js audit <tunnelId>
node dist/cli.js graph <tunnelId>

# Web UI with live SSE stream
node dist/cli.js serve --port 7777

# Federation
node dist/cli.js send --to ../other-burrow --castings <id>
node dist/cli.js send --to https://other:7777 --castings <id>
node dist/cli.js inbox
node dist/cli.js outbox
```

## Environment variables

```bash
OPENAI_API_KEY                  # required
WORMHOLE_MODEL_NIGHTCRAWLER     # default: gpt-5.4-mini
WORMHOLE_MODEL_BLOODWORM        # default: gpt-5.4-mini
WORMHOLE_MODEL_SILKWORM         # default: gpt-5.4-mini
WORMHOLE_MODEL_TAPEWORM         # default: gpt-5.4-mini
WORMHOLE_MODEL_EARTHWORM        # default: gpt-5.5
WORMHOLE_MODEL_GLOWWORM         # default: gpt-5.4-mini
WORMHOLE_MAX_CONCURRENCY        # default: 5 (in-flight OpenAI calls)
WORMHOLE_NO_BANNER              # set to 1 to suppress worm animations
```

## Reward plugins

Drop a `.wormhole/reward.mjs` in your Burrow to override the default scoring:

```js
export default function (castings, verdict) {
  return verdict.passed ? 0.8 + (1 - castings.drift.driftRate) * 0.2 : verdict.score * 0.5;
}
```

## Web UI (SSE)

`wormhole serve` exposes `/tunnel/new` — an HTML form that POSTs to `/api/tunnel` and subscribes to a live SSE stream. Run state is persisted so the stream history replays after a server restart.

## HTTP API

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Dirt overview |
| GET | `/tunnel/new` | Browser form |
| GET | `/tunnel/:id` | Tunnel detail |
| GET | `/dig/:id` | Dig detail |
| GET | `/castings/:id` | Single castings detail |
| GET | `/drift` | Aggregate drift report |
| GET | `/runs` | List of all SSE runs |
| POST | `/api/tunnel` | Start a tunnel, returns `{ runId }` |
| GET | `/api/tunnel/:runId/stream` | SSE stream of step events |
| POST | `/api/inbox` | Federation receiver |

## Burrow layout

```
.wormhole/
  warren.json
  reward.mjs           # optional reward plugin
  hoard/
    loot/<id>.json
    quests/<id>.json
    rites/<id>.json
    inbox/<id>.json
    outbox/<id>.json
  runs/<runId>.json
```

## Tests

```bash
npm test
```

Pure-function coverage: drift, reward, content-addressing, federation signatures, audit, graph, concurrency, budget, run persistence, export, and comparison. No OpenAI calls.

## License

MIT
