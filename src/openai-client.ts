import type { Creature, TokenUsage } from "./types.js";

export interface CallOptions {
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export interface CreatureResponse {
  text: string;
  usage: TokenUsage;
}

const MOCK_DELAY_MS = 400;

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mockUsage(model: string): TokenUsage {
  return { promptTokens: 120, completionTokens: 80, totalTokens: 200, model };
}

const MOCK_RESPONSES: Record<string, string[]> = {
  nightcrawler: [
    "Here is a concise solution that addresses the core requirements. The approach is modular, testable, and handles edge cases gracefully. Each component has a single responsibility and communicates through well-defined interfaces.",
    "The implementation leverages established patterns to ensure maintainability. Input validation occurs at system boundaries, internal logic trusts its invariants, and output is deterministic given the same inputs.",
    "This solution prioritizes clarity over cleverness. The data flows in one direction, side effects are isolated, and the happy path is obvious at a glance.",
  ],
  bloodworm: [
    "ATTACK SURFACE IDENTIFIED: The output assumes valid input without defensive checks. Edge cases near boundaries (empty input, max values, concurrent access) are unhandled. The solution would fail under adversarial conditions.",
    "WEAKNESSES FOUND: No error handling for network failures. The approach breaks if the upstream contract changes. Missing validation on the response shape before consuming it.",
  ],
  silkworm: [
    "Relevant facts extracted: (1) Task requires structured output. (2) Three files directly relevant — see attached context. (3) No conflicting constraints found in the codebase.",
  ],
  tapeworm: [
    JSON.stringify({ passed: true, score: 0.87, critique: "The nightcrawler output is on-task and materially correct. It burrows through the key steps without unnecessary detours. Minor style nits but nothing that blocks a pass." }),
    JSON.stringify({ passed: false, score: 0.31, critique: "Output does not satisfy the task constraints. The approach described would produce incorrect results for non-trivial inputs. Recommend fallback." }),
  ],
  earthworm: [
    "After reviewing all candidate outputs and the adversarial critiques, the strongest path forward is a hybrid of candidates 1 and 3. The core algorithm from candidate 1 is sound; the error handling suggested by the bloodworm critique should be applied. Final synthesized answer: implement with explicit validation at entry points, pure transformation in the core, and structured error returns rather than thrown exceptions.",
  ],
  glowworm: [
    "Casting compressed and routed. Signature verified. Payload integrity: OK.",
  ],
};

export async function callCreature(
  creature: Creature,
  _userPrompt: string,
  _opts: CallOptions = {},
): Promise<CreatureResponse> {
  await delay(MOCK_DELAY_MS + Math.random() * 300);
  const pool = MOCK_RESPONSES[creature.kind] ?? ["Mock response."];
  const text = pool[Math.floor(Math.random() * pool.length)];
  return { text, usage: mockUsage(creature.model) };
}

export async function callCreatureStream(
  creature: Creature,
  _userPrompt: string,
  onChunk: (chunk: string) => void,
  _opts: CallOptions = {},
): Promise<CreatureResponse> {
  const pool = MOCK_RESPONSES[creature.kind] ?? ["Mock response."];
  const text = pool[Math.floor(Math.random() * pool.length)];
  const words = text.split(" ");
  for (const word of words) {
    await delay(40 + Math.random() * 40);
    onChunk(word + " ");
  }
  return { text, usage: mockUsage(creature.model) };
}
