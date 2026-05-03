#!/usr/bin/env node
try {
  process.loadEnvFile?.();
} catch {
  // no .env file — that's fine
}

import { writeFile } from "node:fs/promises";
import { auditRite } from "./audit.js";
import { printBanner } from "./banners.js";
import { compareRites } from "./compare.js";
import { makeCreature } from "./creatures.js";
import { measureDrift } from "./drift.js";
import { exportRiteMarkdown } from "./export.js";
import { sendToWarren, sendToWarrenHttp, verifyInbox } from "./federation.js";
import { renderLootAncestry, renderRiteGraph } from "./graph.js";
import { callCreatureStream } from "./openai-client.js";
import { dispatchQuest } from "./quest.js";
import { reroll } from "./reroll.js";
import { performRite, type RiteStep } from "./rite.js";
import { loadRewardPlugin } from "./reward-plugin.js";
import { previewScan, scavenge } from "./scavenge.js";
import { serve } from "./server.js";
import {
  CREATURE_KINDS,
  type CreatureKind,
  type Loot,
  type Personality,
} from "./types.js";
import { initWarren, loadWarren } from "./warren.js";

const HELP = `Wormhole — worm-powered agent orchestration protocol.

Usage:
  wormhole init
      Initialize a Burrow in the current directory.

  wormhole wriggle <kind> --task "..." [--personality <p>]
      Run a single worm once. Output goes to stdout; castings are stashed.
      Kinds: ${CREATURE_KINDS.join(" ")}

  wormhole scavenge --task "..." --scan "<glob>" [--scan "<glob>"]...
      Run a Silkworm over matched files and stash the distilled facts.

  wormhole dig "<task>" [--pack <N>] [--personality <p>]
      Nightcrawler pack with Tapeworm arbitration. Default pack=3. Lightweight.

  wormhole tunnel "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback]
                           [--budget <tokens>] [--max-output <tokens>]
      Full ceremony: Silkworm → Nightcrawler pack → Bloodworm chaos → Tapeworm review → Earthworm fallback.

  wormhole reroll <tunnelId> [--no-fallback] [--budget <tokens>]
      Re-run an existing tunnel with identical task / pack / personality / scan.

  wormhole export <tunnelId> [--out <path.md>]
      Render a Tunnel as a self-contained markdown document.

  wormhole compare <tunnelA> <tunnelB>
      Side-by-side comparison of two tunnels.

  wormhole audit <tunnelId>
      Walk a Tunnel's causal graph; report tokens, drift, longest chain, warnings.

  wormhole graph <tunnelId|castingsId>
      Render the causal graph as ASCII.

  wormhole drift
      Aggregate personality-drift report across all stashed castings.

  wormhole dirt [--kind <k>] [--since <iso|ms>] [--limit <N>] [--tunnel <id>] [--dig <id>]
      List the contents of the Dirt, optionally filtered.

  wormhole send --to <burrow-path> --castings <id> [--audience "..."]
      Glowworm-compress castings and deliver them to another Burrow's inbox.

  wormhole inbox
      List inbox messages and verify their signatures.

  wormhole outbox
      List outbox records.

  wormhole serve [--port <N>]
      Start the Dirt web UI. Default port=7777.

Environment:
  OPENAI_API_KEY                  required (except for init / drift / dirt / inbox / outbox / audit / graph / export / compare)
  WORMHOLE_MODEL_NIGHTCRAWLER     default: gpt-5.4-mini
  WORMHOLE_MODEL_EARTHWORM        default: gpt-5.5
  WORMHOLE_MODEL_TAPEWORM         default: gpt-5.4-mini
  WORMHOLE_MAX_CONCURRENCY        default: 5 (in-flight OpenAI calls)
  (also: BLOODWORM, SILKWORM, GLOWWORM)

"The worms will inherit the context window."
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }

  switch (cmd) {
    case "init":
      return cmdInit();
    case "wriggle":
      return cmdWriggle(argv.slice(1));
    case "scavenge":
      return cmdScavenge(argv.slice(1));
    case "dig":
      return cmdDig(argv.slice(1));
    case "tunnel":
      return cmdTunnel(argv.slice(1));
    case "reroll":
      return cmdReroll(argv.slice(1));
    case "export":
      return cmdExport(argv.slice(1));
    case "compare":
      return cmdCompare(argv.slice(1));
    case "audit":
      return cmdAudit(argv.slice(1));
    case "graph":
      return cmdGraph(argv.slice(1));
    case "drift":
      return cmdDrift();
    case "dirt":
      return cmdDirt(argv.slice(1));
    case "send":
      return cmdSend(argv.slice(1));
    case "inbox":
      return cmdInbox();
    case "outbox":
      return cmdOutbox();
    case "serve":
      return cmdServe(argv.slice(1));
    default:
      process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

async function cmdInit(): Promise<void> {
  const w = await initWarren(process.cwd());
  process.stdout.write(
    `Burrow "${w.manifest.name}" initialized at ${w.root}.\n` +
      `Dirt is empty. Wriggle something.\n`,
  );
}

async function cmdWriggle(args: string[]): Promise<void> {
  const kind = args[0] as CreatureKind | undefined;
  if (!kind || !CREATURE_KINDS.includes(kind)) {
    process.stderr.write(
      `usage: wormhole wriggle <${CREATURE_KINDS.join("|")}> --task "..." [--personality <p>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args.slice(1));
  const task = flags.task;
  if (!task) {
    process.stderr.write(`--task is required\n`);
    process.exitCode = 1;
    return;
  }
  const personality = flags.personality as Personality | undefined;
  const creature = makeCreature(kind, personality);

  await printBanner(kind);

  const { text, usage } = await callCreatureStream(creature, task, (chunk) => {
    process.stdout.write(chunk);
  });
  process.stdout.write("\n");

  try {
    const w = await loadWarren(process.cwd());
    const drift = measureDrift(text);
    const loot: Loot = {
      id: "",
      creatureKind: kind,
      personality: creature.personality,
      model: creature.model,
      prompt: task,
      output: text,
      timestamp: Date.now(),
      drift,
      usage,
    };
    await w.hoard.stash(loot);
    process.stdout.write(
      `\n— drift —\n` +
        `  cross-worm words: ${drift.totalCreatureWords} / ${drift.outputWordCount}` +
        `  rate=${drift.driftRate.toFixed(4)}\n` +
        `  ${formatMentions(drift.creatureMentions)}\n` +
        `  castings: ${loot.id}  tokens: ${usage.totalTokens}\n`,
    );
  } catch {
    const drift = measureDrift(text);
    process.stdout.write(
      `\n— drift —\n` +
        `  cross-worm words: ${drift.totalCreatureWords} / ${drift.outputWordCount}` +
        `  rate=${drift.driftRate.toFixed(4)}\n` +
        `  ${formatMentions(drift.creatureMentions)}\n` +
        `  (no Burrow — castings not stashed; tokens=${usage.totalTokens})\n`,
    );
  }
}

async function cmdScavenge(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const task = flags.task;
  if (!task || scanGlobs.length === 0) {
    process.stderr.write(
      `usage: wormhole scavenge --task "..." --scan "<glob>" [--scan "<glob>"]...\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  if (flags.preview === "true") {
    const paths = await previewScan(w.root, scanGlobs);
    process.stdout.write(
      `Would scan ${paths.length} file(s):\n${paths.map((p) => "  " + p).join("\n")}\n`,
    );
    return;
  }
  const result = await scavenge({
    task,
    scanGlobs,
    cwd: w.root,
    hoard: w.hoard,
    personality: flags.personality as Personality | undefined,
  });
  process.stdout.write(
    `Silkworm scavenged ${result.files.length} file(s). Castings: ${result.loot.id}\n\n` +
      `${result.facts}\n`,
  );
}

async function cmdDig(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(
      `usage: wormhole dig "<task>" [--pack <N>] [--personality <p>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const packSize = flags.pack ? Number(flags.pack) : 3;
  const personality = flags.personality as Personality | undefined;

  const w = await loadWarren(process.cwd());

  process.stdout.write(
    `Dispatching ${packSize} nightcrawler(s) on dig "${truncate(task, 60)}"...\n`,
  );
  const t0 = Date.now();
  const result = await dispatchQuest({
    task,
    packSize,
    hoard: w.hoard,
    personality,
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(
    `\nDig ${result.quest.id} finished in ${dt}s.\n\n`,
  );
  for (const l of result.loot) {
    const v = result.quest.trollVerdicts[l.id];
    const tag = l.id === result.winner.id ? "  <-- WINNER" : "";
    process.stdout.write(
      `  ${l.id}  castings=${(l.reward ?? 0).toFixed(3)}  ` +
        `tapeworm=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}  ` +
        `drift=${l.drift.driftRate.toFixed(4)}${tag}\n`,
    );
    process.stdout.write(`     critique: ${truncate(v.critique, 120)}\n`);
  }
  process.stdout.write(`\n— winning castings —\n\n${result.winner.output}\n`);
}

async function cmdTunnel(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const task = positional[0];
  if (!task) {
    process.stderr.write(
      `usage: wormhole tunnel "<task>" [--pack <N>] [--scan <glob>]... [--personality <p>] [--no-fallback] [--budget <tokens>] [--max-output <tokens>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const scanGlobs = collectFlag(args, "scan");
  const packSize = flags.pack ? Number(flags.pack) : 3;
  const personality = flags.personality as Personality | undefined;
  const noFallback = flags["no-fallback"] === "true";
  const budgetTokens = flags.budget ? Number(flags.budget) : undefined;
  const maxOutputTokensPerCall = flags["max-output"]
    ? Number(flags["max-output"])
    : undefined;

  const w = await loadWarren(process.cwd());
  const rewardPlugin = await loadRewardPlugin(w.root);
  if (rewardPlugin.source !== "builtin") {
    process.stdout.write(`(reward plugin: ${rewardPlugin.source})\n`);
  }
  process.stdout.write(
    `Beginning tunnel (pack=${packSize}, scan=${scanGlobs.length} glob(s)` +
      `${budgetTokens ? `, budget=${budgetTokens}` : ""})...\n`,
  );

  const t0 = Date.now();
  const result = await performRite({
    task,
    packSize,
    scanGlobs,
    cwd: w.root,
    hoard: w.hoard,
    personality,
    rewardFn: rewardPlugin.fn,
    noFallback,
    budgetTokens,
    maxOutputTokensPerCall,
    onStep: (s) => process.stdout.write(formatTunnelStep(s) + "\n"),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  process.stdout.write(`\nTunnel ${result.rite.id} finished in ${dt}s — ${result.rite.outcome}.\n\n`);

  for (const gid of result.rite.goblinLootIds) {
    const v = result.rite.trollVerdicts[gid];
    const tag = gid === result.rite.winnerLootId ? "  <-- WINNER" : "";
    const tline =
      v
        ? `tapeworm=${v.score.toFixed(2)} ${v.passed ? "PASS" : "FAIL"}`
        : "tapeworm=—";
    process.stdout.write(`  nightcrawler ${gid}  ${tline}${tag}\n`);
    if (v?.critique) {
      process.stdout.write(`    critique: ${truncate(v.critique, 120)}\n`);
    }
  }
  if (result.rite.ogreLootId) {
    process.stdout.write(`  earthworm   ${result.rite.ogreLootId}  (fallback)\n`);
  }

  process.stdout.write(`\n— winning castings —\n\n${result.winnerLoot.output}\n`);
}

function formatTunnelStep(s: RiteStep): string {
  switch (s.kind) {
    case "scavenge:start":
      return `  silkworm scavenging (${s.globs.length} glob(s))...`;
    case "scavenge:done":
      return `  silkworm stashed ${s.lootId} (${s.fileCount} file(s))`;
    case "pack:start":
      return `  dispatching pack of ${s.size}...`;
    case "pack:nightcrawler":
      return `    nightcrawler ${s.index + 1} → ${s.lootId}`;
    case "chaos:start":
      return `  bloodworms running chaos pass...`;
    case "chaos:done":
      return `    bloodworm → ${s.bloodwormId} (on nightcrawler ${s.nightcrawlerId})`;
    case "review:start":
      return `  tapeworm reviewing...`;
    case "review:verdict":
      return `    tapeworm: ${s.verdict.passed ? "PASS" : "FAIL"} score=${s.verdict.score.toFixed(2)} (${s.verdict.lootId})`;
    case "fallback:start":
      return `  pack failed; summoning earthworm...`;
    case "fallback:done":
      return `  earthworm delivered ${s.lootId}`;
    case "budget:exceeded":
      return `  ⚠ budget exceeded at ${s.phase}: used ${s.used} / cap ${s.cap}`;
    case "rite:done":
      return `  tunnel outcome: ${s.outcome}`;
  }
}

async function cmdReroll(args: string[]): Promise<void> {
  const tunnelId = args.find((a) => !a.startsWith("--"));
  if (!tunnelId) {
    process.stderr.write(
      `usage: wormhole reroll <tunnelId> [--no-fallback] [--budget <tokens>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const rewardPlugin = await loadRewardPlugin(w.root);
  const original = await w.hoard.getRite(tunnelId);
  if (!original) {
    process.stderr.write(`Tunnel ${tunnelId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Rerolling tunnel ${tunnelId}\n` +
      `  task: "${truncate(original.task, 80)}"\n` +
      `  pack=${original.packSize}  personality=${original.personality}\n`,
  );
  const t0 = Date.now();
  const result = await reroll({
    riteId: tunnelId,
    cwd: w.root,
    hoard: w.hoard,
    rewardFn: rewardPlugin.fn,
    noFallback: flags["no-fallback"] === "true",
    budgetTokens: flags.budget ? Number(flags.budget) : undefined,
    onStep: (s) => process.stdout.write(formatTunnelStep(s) + "\n"),
  });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(
    `\nNew tunnel ${result.rite.id} (${result.rite.outcome}) in ${dt}s.\n` +
      `Compare: wormhole compare ${tunnelId} ${result.rite.id}\n`,
  );
}

async function cmdExport(args: string[]): Promise<void> {
  const tunnelId = args.find((a) => !a.startsWith("--"));
  if (!tunnelId) {
    process.stderr.write(
      `usage: wormhole export <tunnelId> [--out <path.md>]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const md = await exportRiteMarkdown(w.hoard, tunnelId);
  if (!md) {
    process.stderr.write(`Tunnel ${tunnelId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  if (flags.out) {
    await writeFile(flags.out, md, "utf8");
    process.stdout.write(`Wrote ${md.length} bytes to ${flags.out}\n`);
  } else {
    process.stdout.write(md);
    if (!md.endsWith("\n")) process.stdout.write("\n");
  }
}

async function cmdCompare(args: string[]): Promise<void> {
  const positional = args.filter((a) => !a.startsWith("--"));
  const [a, b] = positional;
  if (!a || !b) {
    process.stderr.write(`usage: wormhole compare <tunnelA> <tunnelB>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const report = await compareRites(w.hoard, a, b);
  if (!report) {
    process.stderr.write(`One or both tunnels not found (${a}, ${b}).\n`);
    process.exitCode = 1;
    return;
  }
  const fmt = (label: string, x: typeof report.a) =>
    `${label} ${x.rite.id}\n` +
    `  outcome:        ${x.rite.outcome}\n` +
    `  pack:           ${x.rite.packSize}\n` +
    `  personality:    ${x.rite.personality}\n` +
    `  total castings: ${x.totalLoot}\n` +
    `  total tokens:   ${x.totalTokens}\n` +
    `  avg drift rate: ${x.avgDriftRate.toFixed(4)}\n` +
    `  pass rate:      ${(x.passRate * 100).toFixed(0)}%\n`;
  process.stdout.write(
    fmt("A:", report.a) + "\n" + fmt("B:", report.b) + "\n",
  );
  process.stdout.write(
    `task identical: ${report.taskMatches ? "yes" : "no"}\n\n`,
  );
  if (report.a.winner) {
    process.stdout.write(
      `--- winner of A (${report.a.winner.id}) ---\n${report.a.winner.output}\n\n`,
    );
  }
  if (report.b.winner) {
    process.stdout.write(
      `--- winner of B (${report.b.winner.id}) ---\n${report.b.winner.output}\n`,
    );
  }
}

async function cmdAudit(args: string[]): Promise<void> {
  const tunnelId = args[0];
  if (!tunnelId) {
    process.stderr.write(`usage: wormhole audit <tunnelId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const report = await auditRite(w.hoard, tunnelId);
  if (!report) {
    process.stderr.write(`Tunnel ${tunnelId} not found.\n`);
    process.exitCode = 1;
    return;
  }
  const r = report.rite;
  process.stdout.write(
    `Audit of tunnel ${r.id}\n` +
      `  outcome:        ${r.outcome}\n` +
      `  task:           "${truncate(r.task, 80)}"\n` +
      `  total castings: ${report.totalLoot}\n` +
      `  tokens:         total=${report.totalTokens} prompt=${report.promptTokens} completion=${report.completionTokens}\n` +
      `  longest chain:  depth=${report.longestChain.length}  ${report.longestChain.lootIds.join(" → ")}\n` +
      `  highest drift:  ${
        report.highestDrift
          ? `${report.highestDrift.kind} ${report.highestDrift.lootId} rate=${report.highestDrift.rate.toFixed(4)}`
          : "(none)"
      }\n\n`,
  );
  process.stdout.write(`By worm kind:\n`);
  for (const [kind, stats] of Object.entries(report.byKind)) {
    if (stats.count === 0) continue;
    process.stdout.write(
      `  ${kind.padEnd(12)} n=${stats.count}  tokens=${stats.totalTokens}  ` +
        `avg drift=${stats.avgDriftRate.toFixed(4)}  avg castings=${stats.avgRewardOrZero.toFixed(3)}\n`,
    );
  }
  if (report.warnings.length > 0) {
    process.stdout.write(`\nWarnings:\n`);
    for (const w of report.warnings) process.stdout.write(`  ⚠ ${w}\n`);
  }
}

async function cmdGraph(args: string[]): Promise<void> {
  const id = args[0];
  if (!id) {
    process.stderr.write(`usage: wormhole graph <tunnelId|castingsId>\n`);
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const riteRendered = await renderRiteGraph(w.hoard, id);
  if (riteRendered) {
    process.stdout.write(riteRendered + "\n");
    return;
  }
  const lootRendered = await renderLootAncestry(w.hoard, id);
  if (lootRendered) {
    process.stdout.write(lootRendered + "\n");
    return;
  }
  process.stderr.write(`No tunnel or castings found with id ${id}.\n`);
  process.exitCode = 1;
}

async function cmdDrift(): Promise<void> {
  const w = await loadWarren(process.cwd());
  const all = await w.hoard.allLoot();
  if (all.length === 0) {
    process.stdout.write(`Dirt is empty.\n`);
    return;
  }
  process.stdout.write(`Dirt contains ${all.length} castings drop(s).\n\n`);

  const byKind = new Map<CreatureKind, number[]>();
  for (const k of CREATURE_KINDS) byKind.set(k, []);
  for (const l of all) byKind.get(l.creatureKind)?.push(l.drift.driftRate);

  process.stdout.write(
    `Drift rate by worm kind (cross-worm mentions / total words):\n`,
  );
  for (const k of CREATURE_KINDS) {
    const rates = byKind.get(k) ?? [];
    if (rates.length === 0) {
      process.stdout.write(`  ${k.padEnd(12)} (n=0)\n`);
      continue;
    }
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    process.stdout.write(
      `  ${k.padEnd(12)} avg=${avg.toFixed(4)}  n=${rates.length}\n`,
    );
  }
  process.stdout.write(
    `\nReminder: high cross-worm drift means your reward signal is leaking.\n` +
      `That is the exact bug from the Incident. Tune accordingly.\n`,
  );
}

async function cmdDirt(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const w = await loadWarren(process.cwd());
  const limit = flags.limit ? Math.max(1, Number(flags.limit)) : Infinity;
  const since = flags.since ? parseTimestamp(flags.since) : null;
  const kind = flags.kind as CreatureKind | undefined;
  const filterTunnel = flags.tunnel;
  const filterDig = flags.dig;

  if (kind && !CREATURE_KINDS.includes(kind)) {
    process.stderr.write(`unknown --kind: ${kind}\n`);
    process.exitCode = 1;
    return;
  }

  let loot = await w.hoard.allLoot();
  if (kind) loot = loot.filter((l) => l.creatureKind === kind);
  if (since !== null) loot = loot.filter((l) => l.timestamp >= since);
  if (filterTunnel) loot = loot.filter((l) => l.riteId === filterTunnel);
  if (filterDig) loot = loot.filter((l) => l.questId === filterDig);
  loot.sort((a, b) => b.timestamp - a.timestamp);
  if (Number.isFinite(limit)) loot = loot.slice(0, limit);

  let rites = await w.hoard.allRites();
  if (since !== null) rites = rites.filter((r) => r.startedAt >= since);
  rites.sort((a, b) => b.startedAt - a.startedAt);

  let quests = await w.hoard.allQuests();
  if (since !== null) quests = quests.filter((q) => q.startedAt >= since);
  quests.sort((a, b) => b.startedAt - a.startedAt);

  process.stdout.write(
    `Dirt at ${w.root}\n` +
      `  castings: ${loot.length}${kind ? ` (kind=${kind})` : ""}` +
      `${since !== null ? ` (since=${new Date(since).toISOString()})` : ""}\n` +
      `  digs:     ${quests.length}\n` +
      `  tunnels:  ${rites.length}\n\n`,
  );

  if (kind || filterTunnel || filterDig || since !== null) {
    for (const l of loot) {
      const tokens = l.usage ? `tokens=${l.usage.totalTokens} ` : "";
      process.stdout.write(
        `  ${l.creatureKind.padEnd(12)} ${l.id}  ${tokens}drift=${l.drift.driftRate.toFixed(4)}` +
          ` ${new Date(l.timestamp).toISOString()}\n`,
      );
    }
    return;
  }

  for (const r of rites) {
    process.stdout.write(
      `  tunnel  ${r.id}  ${r.outcome.padEnd(15)}  pack=${r.packSize}\n` +
        `    "${truncate(r.task, 80)}"\n`,
    );
  }
  for (const q of quests) {
    process.stdout.write(
      `  dig     ${q.id}  pack=${q.packSize}  winner=${q.winnerLootId ?? "—"}\n` +
        `    "${truncate(q.task, 80)}"\n`,
    );
  }
}

function parseTimestamp(raw: string): number {
  const asNum = Number(raw);
  if (Number.isFinite(asNum) && raw.trim().length > 0) {
    if (raw.length <= 10) return asNum * 1000;
    return asNum;
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return parsed;
  throw new Error(`Could not parse --since value: ${raw}`);
}

async function cmdSend(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const to = flags.to;
  const castingsId = flags.castings;
  if (!to || !castingsId) {
    process.stderr.write(
      `usage: wormhole send --to <burrow-path-or-url> --castings <id> [--audience "..."]\n`,
    );
    process.exitCode = 1;
    return;
  }
  const w = await loadWarren(process.cwd());
  const isUrl = /^https?:\/\//i.test(to);
  if (isUrl) {
    const result = await sendToWarrenHttp({
      fromWarrenName: w.manifest.name,
      fromHoard: w.hoard,
      fromPeerSecret: w.manifest.peerSecret,
      toUrl: to,
      sourceLootId: castingsId,
      audience: flags.audience,
      personality: flags.personality as Personality | undefined,
    });
    process.stdout.write(
      `Glowworm delivered to ${to} (remote id ${result.remoteId}).\n` +
        `  source castings:  ${result.outbox.sourceLootId}\n` +
        `  glowworm castings:  ${result.outbox.pigeonLootId}\n` +
        `  signature:    ${result.outbox.signature}\n`,
    );
    return;
  }
  const result = await sendToWarren({
    fromWarrenName: w.manifest.name,
    fromHoard: w.hoard,
    fromPeerSecret: w.manifest.peerSecret,
    toWarrenPath: to,
    sourceLootId: castingsId,
    audience: flags.audience,
    personality: flags.personality as Personality | undefined,
  });
  process.stdout.write(
    `Glowworm delivered ${result.outbox.id} to ${result.deliveredTo}.\n` +
      `  source castings:  ${result.outbox.sourceLootId}\n` +
      `  glowworm castings:  ${result.outbox.pigeonLootId}\n` +
      `  signature:    ${result.outbox.signature}\n`,
  );
}

async function cmdInbox(): Promise<void> {
  const w = await loadWarren(process.cwd());
  const msgs = (await w.hoard.allInbox()).sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );
  if (msgs.length === 0) {
    process.stdout.write(`Inbox empty.\n`);
    return;
  }
  for (const m of msgs) {
    const ok = verifyInbox(m, w.manifest.peerSecret);
    process.stdout.write(
      `${m.id}  from=${m.fromWarren}  audience="${m.audience}"  ${ok ? "VERIFIED" : "BAD-SIG"}\n` +
        `  ${truncate(m.body, 200)}\n`,
    );
  }
}

async function cmdOutbox(): Promise<void> {
  const w = await loadWarren(process.cwd());
  const recs = (await w.hoard.allOutbox()).sort(
    (a, b) => b.sentAt - a.sentAt,
  );
  if (recs.length === 0) {
    process.stdout.write(`Outbox empty.\n`);
    return;
  }
  for (const r of recs) {
    process.stdout.write(
      `${r.id}  to=${r.toWarren}  source=${r.sourceLootId}  glowworm=${r.pigeonLootId}\n`,
    );
  }
}

async function cmdServe(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const port = flags.port ? Number(flags.port) : 7777;
  await serve({ cwd: process.cwd(), port });
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = "true";
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function collectFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] && !args[i + 1].startsWith("--")) {
      out.push(args[i + 1]);
      i++;
    }
  }
  return out;
}

function formatMentions(m: Record<CreatureKind, number>): string {
  return CREATURE_KINDS.map((k) => `${k}:${m[k]}`).join(" ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

main().catch((err) => {
  process.stderr.write(`\nWormhole error: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
