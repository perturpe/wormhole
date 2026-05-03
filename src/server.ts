import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { verifyInbox } from "./federation.js";
import { performRite, type RiteStep } from "./rite.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import {
  ensureRunDir,
  loadAllRuns,
  saveRun,
  type RunRecord,
} from "./run-store.js";
import {
  CREATURE_KINDS,
  type CreatureKind,
  type InboxMessage,
  type Personality,
} from "./types.js";
import { loadWarren, type Warren } from "./warren.js";

export interface ServeOptions {
  cwd: string;
  port: number;
}

interface RunState {
  record: RunRecord;
  subscribers: Set<Response>;
}

export async function serve(opts: ServeOptions): Promise<void> {
  const warren = await loadWarren(opts.cwd);
  const app = express();
  const runs = new Map<string, RunState>();
  const runDir = await ensureRunDir(warren.root);

  const persisted = await loadAllRuns(runDir);
  for (const rec of persisted) {
    if (!rec.done) {
      rec.done = true;
      rec.error = rec.error ?? "interrupted (server restarted)";
      rec.finishedAt = rec.finishedAt ?? Date.now();
      await saveRun(runDir, rec);
    }
    runs.set(rec.runId, { record: rec, subscribers: new Set() });
  }

  app.use(express.json({ limit: "1mb" }));
  app.use((_req, res, next) => {
    res.setHeader("X-Wormhole-Burrow", warren.manifest.name);
    next();
  });

  app.get("/", async (_req, res) => renderHome(warren, runs, res));
  app.get("/tunnel/new", (_req, res) =>
    res.send(layout("New Tunnel", newTunnelForm())),
  );
  app.get("/tunnel/:id", async (req, res) => renderTunnel(warren, req, res));
  app.get("/dig/:id", async (req, res) => renderDig(warren, req, res));
  app.get("/castings/:id", async (req, res) => renderCastings(warren, req, res));
  app.get("/drift", async (_req, res) => renderDrift(warren, res));
  app.get("/inbox", async (_req, res) => renderInbox(warren, res));
  app.get("/outbox", async (_req, res) => renderOutbox(warren, res));
  app.get("/runs", async (_req, res) => renderRuns(runs, res));

  app.post("/api/tunnel", async (req, res) =>
    startTunnelRun(warren, runs, runDir, req, res),
  );
  app.get("/api/tunnel/:runId/stream", (req, res) =>
    streamTunnelRun(runs, req, res),
  );
  app.get("/api/runs", (_req, res) =>
    res.json(
      [...runs.values()]
        .map((r) => r.record)
        .sort((a, b) => b.startedAt - a.startedAt),
    ),
  );
  app.post("/api/inbox", async (req, res) => receiveInboxOverHttp(warren, req, res));

  app.use((_req, res) =>
    res
      .status(404)
      .send(layout("Not Found", "<h1>404</h1><p>The Dirt does not contain that.</p>")),
  );

  await new Promise<void>((resolve) => {
    app.listen(opts.port, () => {
      process.stdout.write(
        `Dirt UI listening on http://localhost:${opts.port}/\n` +
          `Burrow: ${warren.manifest.name}  (${warren.root})\n`,
      );
      resolve();
    });
  });
}

async function startTunnelRun(
  warren: Warren,
  runs: Map<string, RunState>,
  runDir: string,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as {
    task?: unknown;
    packSize?: unknown;
    scanGlobs?: unknown;
    personality?: unknown;
    noFallback?: unknown;
    budgetTokens?: unknown;
    maxOutputTokens?: unknown;
  };
  if (typeof body.task !== "string" || body.task.trim().length === 0) {
    res.status(400).json({ error: "task is required" });
    return;
  }
  const runId = randomUUID().slice(0, 12);
  const personality =
    typeof body.personality === "string"
      ? (body.personality as Personality)
      : undefined;
  const scanGlobs = Array.isArray(body.scanGlobs)
    ? (body.scanGlobs.filter((g) => typeof g === "string") as string[])
    : [];
  const packSize = typeof body.packSize === "number" ? body.packSize : 3;
  const noFallback = !!body.noFallback;
  const budgetTokens =
    typeof body.budgetTokens === "number" && body.budgetTokens > 0
      ? body.budgetTokens
      : undefined;
  const maxOutputTokens =
    typeof body.maxOutputTokens === "number" && body.maxOutputTokens > 0
      ? body.maxOutputTokens
      : undefined;

  const record: RunRecord = {
    runId,
    task: body.task,
    packSize,
    scanGlobs,
    personality,
    noFallback,
    events: [],
    done: false,
    startedAt: Date.now(),
  };
  await saveRun(runDir, record);

  const state: RunState = { record, subscribers: new Set() };
  runs.set(runId, state);

  let pendingSave: NodeJS.Timeout | null = null;
  const persist = () => {
    if (pendingSave) return;
    pendingSave = setTimeout(() => {
      pendingSave = null;
      void saveRun(runDir, state.record);
    }, 100);
  };
  const persistNow = async () => {
    if (pendingSave) {
      clearTimeout(pendingSave);
      pendingSave = null;
    }
    await saveRun(runDir, state.record);
  };

  const emit = (kind: string, data: unknown) => {
    const ev = { seq: state.record.events.length, kind, data };
    state.record.events.push(ev);
    for (const sub of state.subscribers) writeSse(sub, ev);
    persist();
  };

  const finish = async () => {
    state.record.done = true;
    state.record.finishedAt = Date.now();
    await persistNow();
    for (const sub of state.subscribers) {
      try {
        sub.end();
      } catch {
        // already closed
      }
    }
  };

  const rewardPlugin = await loadRewardPlugin(warren.root);
  if (rewardPlugin.source !== "builtin") {
    emit("reward-plugin", { source: rewardPlugin.source });
  }

  performRite({
    task: body.task,
    packSize,
    scanGlobs,
    cwd: warren.root,
    hoard: warren.hoard,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    budgetTokens,
    maxOutputTokensPerCall: maxOutputTokens,
    onStep: (step: RiteStep) => emit("step", step),
  })
    .then(async (result) => {
      state.record.finalRiteId = result.rite.id;
      state.record.outcome = result.rite.outcome;
      emit("done", {
        tunnelId: result.rite.id,
        outcome: result.rite.outcome,
        winnerCastingsId: result.rite.winnerLootId,
      });
      await finish();
    })
    .catch(async (err: unknown) => {
      state.record.error =
        err instanceof Error ? err.message : String(err);
      emit("error", { message: state.record.error });
      await finish();
    });

  res.json({ runId });
}

function streamTunnelRun(
  runs: Map<string, RunState>,
  req: Request,
  res: Response,
): void {
  const state = runs.get(req.params.runId);
  if (!state) {
    res.status(404).end();
    return;
  }
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();
  for (const ev of state.record.events) writeSse(res, ev);
  if (state.record.done) {
    res.end();
    return;
  }
  state.subscribers.add(res);
  req.on("close", () => state.subscribers.delete(res));
}

function writeSse(res: Response, ev: { seq: number; kind: string; data: unknown }): void {
  res.write(`id: ${ev.seq}\n`);
  res.write(`event: ${ev.kind}\n`);
  res.write(`data: ${JSON.stringify(ev.data)}\n\n`);
}

async function renderRuns(
  runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const records = [...runs.values()]
    .map((s) => s.record)
    .sort((a, b) => b.startedAt - a.startedAt);
  const rows = records
    .map((r) => {
      const status = r.done
        ? r.error
          ? `<span class="tag tag-fail">error</span>`
          : `<span class="tag tag-pass">done</span>`
        : `<span class="tag tag-winner">running</span>`;
      const link = r.finalRiteId
        ? `<a href="/tunnel/${esc(r.finalRiteId)}">${esc(r.finalRiteId)}</a>`
        : "—";
      return `<tr>
        <td>${esc(r.runId)}</td>
        <td>${status}</td>
        <td>${link}</td>
        <td>${r.events.length}</td>
        <td>${esc(new Date(r.startedAt).toISOString())}</td>
        <td><pre>${esc(r.task.slice(0, 200))}</pre></td>
      </tr>`;
    })
    .join("");
  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Runs (${records.length})</h1>
    <table>
      <tr><th>runId</th><th>status</th><th>tunnel</th><th>events</th><th>started</th><th>task</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">none</td></tr>`}
    </table>
  `;
  res.send(layout("Runs", body));
}

async function receiveInboxOverHttp(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const body = (req.body ?? {}) as Partial<InboxMessage>;
  const required: (keyof InboxMessage)[] = [
    "fromWarren",
    "audience",
    "body",
    "signature",
    "sourceLootId",
  ];
  for (const k of required) {
    if (typeof body[k] !== "string") {
      res.status(400).json({ error: `${k} required` });
      return;
    }
  }
  const candidate: InboxMessage = {
    id: randomUUID().slice(0, 12),
    fromWarren: body.fromWarren as string,
    audience: body.audience as string,
    body: body.body as string,
    signature: body.signature as string,
    sourceLootId: body.sourceLootId as string,
    receivedAt: Date.now(),
  };
  if (!verifyInbox(candidate, warren.manifest.peerSecret)) {
    const reason = warren.manifest.peerSecret
      ? "signature or HMAC invalid"
      : "signature mismatch";
    res.status(400).json({ error: reason });
    return;
  }
  await warren.hoard.stashInbox(candidate);
  res.json({ ok: true, id: candidate.id });
}

async function renderHome(
  warren: Warren,
  runs: Map<string, RunState>,
  res: Response,
): Promise<void> {
  const [rites, quests, loot, inbox] = await Promise.all([
    warren.hoard.allRites(),
    warren.hoard.allQuests(),
    warren.hoard.allLoot(),
    warren.hoard.allInbox(),
  ]);
  rites.sort((a, b) => b.startedAt - a.startedAt);
  quests.sort((a, b) => b.startedAt - a.startedAt);

  const stats = wormCounts(loot);
  const activeRuns = [...runs.values()].filter((r) => !r.record.done).length;

  const body = `
    <h1>Dirt — ${esc(warren.manifest.name)}</h1>
    <p class="muted">${loot.length} castings · ${rites.length} tunnels · ${quests.length} digs · ${inbox.length} in inbox · <a href="/runs">${runs.size} runs</a>${activeRuns > 0 ? ` (${activeRuns} active)` : ""} · <a href="/tunnel/new">+ new tunnel</a></p>

    <section>
      <h2>By worm</h2>
      <table>
        <tr>${CREATURE_KINDS.map((k) => `<th>${k}</th>`).join("")}</tr>
        <tr>${CREATURE_KINDS.map((k) => `<td>${stats[k] ?? 0}</td>`).join("")}</tr>
      </table>
    </section>

    <section>
      <h2>Recent tunnels</h2>
      ${
        rites.length === 0
          ? `<p class="muted">No tunnels yet.</p>`
          : `<ul>${rites
              .slice(0, 25)
              .map(
                (r) =>
                  `<li><a href="/tunnel/${esc(r.id)}">tunnel ${esc(r.id)}</a> — <span class="tag tag-${esc(r.outcome)}">${esc(r.outcome)}</span> · pack=${r.packSize} · "${esc(truncate(r.task, 80))}"</li>`,
              )
              .join("")}</ul>`
      }
    </section>

    <section>
      <h2>Recent digs</h2>
      ${
        quests.length === 0
          ? `<p class="muted">No digs yet.</p>`
          : `<ul>${quests
              .slice(0, 25)
              .map(
                (q) =>
                  `<li><a href="/dig/${esc(q.id)}">dig ${esc(q.id)}</a> · pack=${q.packSize} · "${esc(truncate(q.task, 80))}"</li>`,
              )
              .join("")}</ul>`
      }
    </section>

    <section>
      <h2>Quick links</h2>
      <ul>
        <li><a href="/drift">Drift report</a></li>
        <li><a href="/inbox">Inbox</a></li>
        <li><a href="/outbox">Outbox</a></li>
      </ul>
    </section>
  `;
  res.send(layout("Dirt", body));
}

async function renderTunnel(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const rite = await warren.hoard.getRite(req.params.id);
  if (!rite) {
    res.status(404).send(layout("Not Found", "<h1>Tunnel not found</h1>"));
    return;
  }
  const allLootIds = new Set<string>();
  if (rite.contextLootId) allLootIds.add(rite.contextLootId);
  for (const id of rite.goblinLootIds) allLootIds.add(id);
  for (const id of Object.values(rite.chaosLootIds)) allLootIds.add(id);
  if (rite.ogreLootId) allLootIds.add(rite.ogreLootId);

  const loots = await Promise.all(
    [...allLootIds].map((id) => warren.hoard.getLoot(id)),
  );
  const lootById = new Map(loots.filter((l) => l).map((l) => [l!.id, l!]));

  const nightcrawlerRows = rite.goblinLootIds
    .map((gid) => {
      const g = lootById.get(gid);
      const v = rite.trollVerdicts[gid];
      const chaosId = rite.chaosLootIds[gid];
      const tag = gid === rite.winnerLootId ? `<span class="tag tag-winner">winner</span>` : "";
      return `<tr>
        <td><a href="/castings/${esc(gid)}">${esc(gid)}</a> ${tag}</td>
        <td>${chaosId ? `<a href="/castings/${esc(chaosId)}">${esc(chaosId)}</a>` : "—"}</td>
        <td>${v ? v.score.toFixed(2) : "—"}</td>
        <td>${v ? (v.passed ? `<span class="tag tag-pass">PASS</span>` : `<span class="tag tag-fail">FAIL</span>`) : "—"}</td>
        <td>${g ? (g.reward ?? 0).toFixed(3) : "—"}</td>
        <td>${g ? g.drift.driftRate.toFixed(4) : "—"}</td>
        <td class="critique">${esc(truncate(v?.critique ?? "", 200))}</td>
      </tr>`;
    })
    .join("");

  const earthworm = rite.ogreLootId ? lootById.get(rite.ogreLootId) : null;

  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Tunnel ${esc(rite.id)}</h1>
    <p class="muted">${esc(new Date(rite.startedAt).toISOString())} · pack=${rite.packSize} · personality=${esc(rite.personality)} · outcome=<span class="tag tag-${esc(rite.outcome)}">${esc(rite.outcome)}</span></p>
    <h2>Task</h2>
    <pre>${esc(rite.task)}</pre>

    ${
      rite.contextLootId
        ? `<h2>Silkworm scavenge</h2>
           <p><a href="/castings/${esc(rite.contextLootId)}">${esc(rite.contextLootId)}</a> · ${rite.scanGlobs.length} glob(s): ${rite.scanGlobs.map((g) => `<code>${esc(g)}</code>`).join(", ")}</p>`
        : ""
    }

    <h2>Pack & arbitration</h2>
    <table>
      <tr><th>Nightcrawler</th><th>Bloodworm</th><th>Tapeworm</th><th></th><th>Castings</th><th>Drift</th><th>Critique</th></tr>
      ${nightcrawlerRows}
    </table>

    ${
      earthworm
        ? `<h2>Earthworm fallback</h2>
           <p><a href="/castings/${esc(earthworm.id)}">${esc(earthworm.id)}</a> — synthesized from ${earthworm.parentLootIds?.length ?? 0} failed attempts.</p>
           <pre>${esc(earthworm.output)}</pre>`
        : ""
    }
  `;
  res.send(layout(`Tunnel ${rite.id}`, body));
}

async function renderDig(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const quests = await warren.hoard.allQuests();
  const quest = quests.find((q) => q.id === req.params.id);
  if (!quest) {
    res.status(404).send(layout("Not Found", "<h1>Dig not found</h1>"));
    return;
  }
  const loots = await Promise.all(
    quest.lootIds.map((id) => warren.hoard.getLoot(id)),
  );

  const rows = loots
    .map((l) => {
      if (!l) return "";
      const v = quest.trollVerdicts[l.id];
      const tag = l.id === quest.winnerLootId ? `<span class="tag tag-winner">winner</span>` : "";
      return `<tr>
        <td><a href="/castings/${esc(l.id)}">${esc(l.id)}</a> ${tag}</td>
        <td>${v ? v.score.toFixed(2) : "—"}</td>
        <td>${v ? (v.passed ? `<span class="tag tag-pass">PASS</span>` : `<span class="tag tag-fail">FAIL</span>`) : "—"}</td>
        <td>${(l.reward ?? 0).toFixed(3)}</td>
        <td>${l.drift.driftRate.toFixed(4)}</td>
        <td class="critique">${esc(truncate(v?.critique ?? "", 200))}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Dig ${esc(quest.id)}</h1>
    <p class="muted">${esc(new Date(quest.startedAt).toISOString())} · pack=${quest.packSize} · personality=${esc(quest.personality)}</p>
    <h2>Task</h2>
    <pre>${esc(quest.task)}</pre>
    <h2>Pack</h2>
    <table>
      <tr><th>Castings</th><th>Tapeworm</th><th></th><th>Score</th><th>Drift</th><th>Critique</th></tr>
      ${rows}
    </table>
  `;
  res.send(layout(`Dig ${quest.id}`, body));
}

async function renderCastings(
  warren: Warren,
  req: Request,
  res: Response,
): Promise<void> {
  const loot = await warren.hoard.getLoot(req.params.id);
  if (!loot) {
    res.status(404).send(layout("Not Found", "<h1>Castings not found</h1>"));
    return;
  }
  const parents = loot.parentLootIds ?? [];
  const driftRows = CREATURE_KINDS.map(
    (k) => `<tr><td>${k}</td><td>${loot.drift.creatureMentions[k]}</td></tr>`,
  ).join("");

  const usageBlock = loot.usage
    ? ` · tokens p=${loot.usage.promptTokens}/c=${loot.usage.completionTokens}/t=${loot.usage.totalTokens}`
    : "";
  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Castings ${esc(loot.id)}</h1>
    <p class="muted">
      ${esc(loot.creatureKind)} · ${esc(loot.personality)} · ${esc(loot.model)} · ${esc(new Date(loot.timestamp).toISOString())}
      ${loot.reward !== undefined ? ` · castings=${loot.reward.toFixed(3)}` : ""}${usageBlock}
    </p>

    ${
      parents.length > 0
        ? `<p>Parents: ${parents.map((p) => `<a href="/castings/${esc(p)}">${esc(p)}</a>`).join(", ")}</p>`
        : ""
    }
    ${loot.questId ? `<p>Dig: <a href="/dig/${esc(loot.questId)}">${esc(loot.questId)}</a></p>` : ""}
    ${loot.riteId ? `<p>Tunnel: <a href="/tunnel/${esc(loot.riteId)}">${esc(loot.riteId)}</a></p>` : ""}

    <h2>Output</h2>
    <pre>${esc(loot.output)}</pre>

    <h2>Prompt</h2>
    <pre>${esc(loot.prompt)}</pre>

    <h2>Drift</h2>
    <p>Cross-worm words: ${loot.drift.totalCreatureWords} / ${loot.drift.outputWordCount} words · rate=${loot.drift.driftRate.toFixed(4)}</p>
    <table><tr><th>Worm</th><th>Mentions</th></tr>${driftRows}</table>
  `;
  res.send(layout(`Castings ${loot.id}`, body));
}

async function renderDrift(warren: Warren, res: Response): Promise<void> {
  const all = await warren.hoard.allLoot();
  const byKind = new Map<CreatureKind, number[]>();
  for (const k of CREATURE_KINDS) byKind.set(k, []);
  for (const l of all) byKind.get(l.creatureKind)?.push(l.drift.driftRate);

  const rows = CREATURE_KINDS.map((k) => {
    const rates = byKind.get(k) ?? [];
    const avg = rates.length
      ? rates.reduce((a, b) => a + b, 0) / rates.length
      : 0;
    return `<tr><td>${k}</td><td>${rates.length}</td><td>${avg.toFixed(4)}</td></tr>`;
  }).join("");

  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Drift report</h1>
    <p class="muted">Cross-worm mentions / total words. High = reward signal is leaking.</p>
    <table>
      <tr><th>Worm</th><th>n</th><th>avg drift rate</th></tr>
      ${rows}
    </table>
    <p class="muted">${all.length} total castings scanned.</p>
  `;
  res.send(layout("Drift", body));
}

async function renderInbox(warren: Warren, res: Response): Promise<void> {
  const msgs = (await warren.hoard.allInbox()).sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );
  const rows = msgs
    .map(
      (m) => `<tr>
        <td>${esc(m.id)}</td>
        <td>${esc(m.fromWarren)}</td>
        <td>${esc(m.audience)}</td>
        <td><code>${esc(m.signature)}</code></td>
        <td><pre>${esc(truncate(m.body, 400))}</pre></td>
      </tr>`,
    )
    .join("");
  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Inbox (${msgs.length})</h1>
    <table>
      <tr><th>id</th><th>from</th><th>audience</th><th>signature</th><th>body</th></tr>
      ${rows || `<tr><td colspan="5" class="muted">empty</td></tr>`}
    </table>
  `;
  res.send(layout("Inbox", body));
}

async function renderOutbox(warren: Warren, res: Response): Promise<void> {
  const recs = (await warren.hoard.allOutbox()).sort(
    (a, b) => b.sentAt - a.sentAt,
  );
  const rows = recs
    .map(
      (r) => `<tr>
        <td>${esc(r.id)}</td>
        <td>${esc(r.toWarren)}</td>
        <td>${esc(r.audience)}</td>
        <td><a href="/castings/${esc(r.sourceLootId)}">${esc(r.sourceLootId)}</a></td>
        <td><a href="/castings/${esc(r.pigeonLootId)}">${esc(r.pigeonLootId)}</a></td>
        <td><code>${esc(r.signature)}</code></td>
      </tr>`,
    )
    .join("");
  const body = `
    <p><a href="/">← Dirt</a></p>
    <h1>Outbox (${recs.length})</h1>
    <table>
      <tr><th>id</th><th>to</th><th>audience</th><th>source</th><th>glowworm</th><th>signature</th></tr>
      ${rows || `<tr><td colspan="6" class="muted">empty</td></tr>`}
    </table>
  `;
  res.send(layout("Outbox", body));
}

function wormCounts(
  loot: { creatureKind: CreatureKind }[],
): Record<CreatureKind, number> {
  const counts: Record<CreatureKind, number> = {
    nightcrawler: 0,
    bloodworm: 0,
    silkworm: 0,
    tapeworm: 0,
    earthworm: 0,
    glowworm: 0,
  };
  for (const l of loot) counts[l.creatureKind]++;
  return counts;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(title)} · Wormhole</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Share+Tech+Mono&display=swap');
  :root { color-scheme: dark; }
  body { font: 13px/1.6 'Share Tech Mono', ui-monospace, Menlo, Consolas, monospace; background: #000000; color: #cccccc; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; }
  h1, h2, h3 { color: #ffffff; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  h1 { border-bottom: 2px solid #333333; padding-bottom: .5rem; font-size: 1.4rem; }
  h2 { font-size: 1rem; color: #dddddd; margin-top: 1.5rem; }
  a { color: #ffffff; text-decoration: underline; text-underline-offset: 3px; }
  a:hover { color: #aaaaaa; }
  pre { background: #0d0d0d; padding: .8rem; border-left: 3px solid #444444; overflow-x: auto; white-space: pre-wrap; word-break: break-word; color: #bbbbbb; }
  code { background: #111111; padding: 1px 4px; border-radius: 2px; color: #eeeeee; }
  table { border-collapse: collapse; margin: .5rem 0 1.5rem; width: 100%; }
  th, td { border: 1px solid #2a2a2a; padding: .35rem .6rem; text-align: left; vertical-align: top; }
  th { background: #111111; color: #ffffff; text-transform: uppercase; font-size: 11px; letter-spacing: .08em; }
  .muted { color: #555555; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 2px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
  .tag-pass { background: #1a1a1a; color: #ffffff; border: 1px solid #555555; }
  .tag-fail { background: #1a1a1a; color: #888888; border: 1px solid #444444; }
  .tag-winner { background: #ffffff; color: #000000; border: 1px solid #ffffff; }
  .tag-winner, .tag-ogre_fallback, .tag-all_failed { padding-left: 6px; padding-right: 6px; }
  .tag-ogre_fallback { background: #333333; color: #cccccc; border: 1px solid #555555; }
  .tag-all_failed { background: #1a1a1a; color: #666666; border: 1px solid #333333; }
  .critique { color: #888888; font-style: italic; max-width: 30ch; }
  section { margin: 1.5rem 0; }
  p.muted { font-size: 12px; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function newTunnelForm(): string {
  return `
    <p><a href="/">← Dirt</a></p>
    <h1>New tunnel</h1>
    <form id="tunnel-form">
      <p><label>Task<br><textarea name="task" rows="4" cols="80" placeholder="What should the nightcrawlers solve?" required></textarea></label></p>
      <p><label>Pack size <input name="packSize" type="number" value="3" min="1" max="9"></label>
         &nbsp;<label>Personality
           <select name="personality">
             <option value="nerdy">nerdy</option>
             <option value="cynical">cynical</option>
             <option value="chipper">chipper</option>
             <option value="stoic">stoic</option>
             <option value="feral">feral</option>
           </select>
         </label>
         &nbsp;<label><input type="checkbox" name="noFallback"> skip Earthworm fallback</label>
      </p>
      <p><label>Scan globs (one per line — optional)<br><textarea name="scanGlobs" rows="3" cols="60" placeholder="src/**/*.ts"></textarea></label></p>
      <p><button type="submit">Begin tunnel</button></p>
    </form>
    <h2>Stream</h2>
    <pre id="log" style="min-height: 12em;">(idle)</pre>
    <p id="winner-link"></p>
    <script>
      const form = document.getElementById("tunnel-form");
      const log = document.getElementById("log");
      const winnerLink = document.getElementById("winner-link");
      function append(s) { log.textContent = (log.textContent === "(idle)" ? "" : log.textContent) + s + "\\n"; log.scrollTop = log.scrollHeight; }
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        log.textContent = "";
        winnerLink.innerHTML = "";
        const fd = new FormData(form);
        const scanGlobs = (fd.get("scanGlobs") || "").toString().split(/\\r?\\n/).map(s => s.trim()).filter(Boolean);
        const payload = {
          task: fd.get("task"),
          packSize: Number(fd.get("packSize") || 3),
          personality: fd.get("personality"),
          noFallback: !!fd.get("noFallback"),
          scanGlobs,
        };
        append("POST /api/tunnel ...");
        const startRes = await fetch("/api/tunnel", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        if (!startRes.ok) { append("error: " + (await startRes.text())); return; }
        const { runId } = await startRes.json();
        append("runId=" + runId + " — opening SSE stream");
        const es = new EventSource("/api/tunnel/" + runId + "/stream");
        es.addEventListener("step", (ev) => {
          const d = JSON.parse(ev.data);
          const k = d.kind;
          let msg = "";
          if (k === "pack:nightcrawler") msg = "nightcrawler " + (d.index + 1) + " → " + d.lootId;
          else if (k === "chaos:done") msg = "bloodworm → " + d.bloodwormId + " (on nightcrawler " + d.nightcrawlerId + ")";
          else if (k === "review:verdict") msg = "tapeworm: " + (d.verdict.passed ? "PASS" : "FAIL") + " score=" + d.verdict.score.toFixed(2);
          else msg = JSON.stringify(d);
          append("∿ " + msg);
        });
        es.addEventListener("reward-plugin", (ev) => append("(reward plugin: " + JSON.parse(ev.data).source + ")"));
        es.addEventListener("done", (ev) => {
          const d = JSON.parse(ev.data);
          append("✔ done — outcome=" + d.outcome + " tunnelId=" + d.tunnelId);
          winnerLink.innerHTML = '<a href="/tunnel/' + d.tunnelId + '">→ view tunnel ' + d.tunnelId + '</a>';
          es.close();
        });
        es.addEventListener("error", (ev) => {
          let msg = "(connection error)";
          try { msg = JSON.parse(ev.data).message; } catch {}
          append("✖ error: " + msg);
          es.close();
        });
      });
    </script>
  `;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}
