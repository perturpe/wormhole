import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { castings } from "../reward.js";
import type { Loot, TrollVerdict } from "../types.js";

function loot(output: string, kind: Loot["creatureKind"] = "nightcrawler"): Loot {
  return {
    id: "x",
    creatureKind: kind,
    personality: "nerdy",
    model: "test",
    prompt: "p",
    output,
    timestamp: 0,
    drift: {
      // drift gets recomputed by castings via crossCreatureDrift; this is unused
      creatureMentions: {
        nightcrawler: 0,
        bloodworm: 0,
        silkworm: 0,
        tapeworm: 0,
        earthworm: 0,
        glowworm: 0,
      },
      totalCreatureWords: 0,
      outputWordCount: 0,
      driftRate: 0,
    },
  };
}

function verdict(score: number, passed: boolean): TrollVerdict {
  return { lootId: "x", passed, score, critique: "" };
}

describe("castings", () => {
  it("clean output passing review hits the pass bonus", () => {
    const r = castings(loot("a clean answer with no creatures"), verdict(0.8, true));
    // 0.8 + 0.1 = 0.9
    assert.equal(r.toFixed(3), "0.900");
  });

  it("clean output failing review gets no pass bonus", () => {
    const r = castings(loot("a clean answer"), verdict(0.4, false));
    assert.equal(r.toFixed(3), "0.400");
  });

  it("cross-creature drift penalises score", () => {
    // 4 words total, 1 raccoon (cross), goblin self-kind
    const drifty = castings(
      loot("answer mentions a raccoon here", "nightcrawler"),
      verdict(0.9, true),
    );
    const clean = castings(
      loot("answer mentions zero creatures here", "nightcrawler"),
      verdict(0.9, true),
    );
    assert.ok(drifty < clean, "drifty output should score lower than clean");
  });

  it("clamps to [0, 1]", () => {
    const r1 = castings(loot("clean"), verdict(2, true));
    const r2 = castings(loot("clean"), verdict(-1, false));
    assert.ok(r1 <= 1);
    assert.ok(r2 >= 0);
  });

  it("drift penalty is bounded", () => {
    // Wall of cross-creature words shouldn't drive castings negative.
    const wall = "raccoon ".repeat(100);
    const r = castings(loot(wall, "nightcrawler"), verdict(0.5, true));
    assert.ok(r >= 0);
    assert.ok(r <= 1);
  });
});
