import type { CreatureKind } from "./types.js";

const NIGHTCRAWLER = String.raw`
   ∿∿∿∿∿∿∿∿∿∿∿∿
  ( ○          ○ )>
   ~~~~~~~~~~~~
`;

const BLOODWORM = String.raw`
   /\/\/\/\/\/\/\
  ( ◉    ╳    ◉ )>>
   \/\/\/\/\/\/\/
`;

const SILKWORM = String.raw`
   ○○○○○○○○○○○
  (  ●        ●  )∿
   ~~~~~~~~~~~
`;

const TAPEWORM = String.raw`
  ══╦══╦══╦══╦══
  ║ ▾              ▾ ║>
  ══╩══╩══╩══╩══
`;

const EARTHWORM = String.raw`
   ████████████████
  █  ●              ●  █>
   ████████████████
    ████████████████
`;

const GLOWWORM = String.raw`
    ✦     ✦     ✦
   ∿∿∿∿∿∿∿∿∿∿∿>
    ✦     ✦     ✦
`;

export const BANNERS: Record<CreatureKind, string> = {
  nightcrawler: NIGHTCRAWLER,
  bloodworm: BLOODWORM,
  silkworm: SILKWORM,
  tapeworm: TAPEWORM,
  earthworm: EARTHWORM,
  glowworm: GLOWWORM,
};

export function bannerFor(kind: CreatureKind): string {
  return BANNERS[kind];
}

async function animateWorm(out: NodeJS.WritableStream): Promise<void> {
  const body = "∿∿∿∿∿∿∿∿∿∿";
  const width = 40;
  const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // crawl in
  for (let i = 0; i <= width; i++) {
    const pad = " ".repeat(i);
    const tail = body.slice(0, Math.min(i, body.length));
    out.write(`\r${pad}~${tail}>`);
    await delay(20);
  }
  // pause
  await delay(80);
  // crawl off screen
  for (let i = 1; i <= 12; i++) {
    const pad = " ".repeat(width + i);
    out.write(`\r${pad}>`);
    await delay(20);
  }
  out.write("\r" + " ".repeat(width + 14) + "\r");
}

/**
 * Print a creature banner with a worm crawl animation.
 * Suppress with WORMHOLE_NO_BANNER=1.
 */
export async function printBanner(
  kind: CreatureKind,
  out: NodeJS.WritableStream = process.stderr,
): Promise<void> {
  if (process.env.WORMHOLE_NO_BANNER === "1") return;
  await animateWorm(out);
  out.write(BANNERS[kind] + "\n");
}
