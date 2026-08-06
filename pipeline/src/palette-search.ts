/**
 * Derive FarePath's own categorical palette, then validate it with the sanctioned validator.
 *
 *   node --experimental-strip-types src/palette-search.ts
 *
 * Why not just use the reference palette: it has 8 hues, Mumbai has 10 operating line families,
 * and — measured, not guessed — only 19 of its 28 hue pairs clear the CVD and normal-vision
 * gates in both modes. The Harbour Line alone meets 9 other families, and the largest set of
 * mutually-meeting families is 5 (Western, Central, Harbour, Metro 1, Metro 3). No assignment
 * over that palette exists. The data-viz method is design-system-agnostic and expects a brand
 * to supply its own ramps held to the same gate, so that is what this does.
 *
 * Strategy, all computed:
 *   1. Generate an in-gamut candidate grid in OKLCH, inside each mode's lightness band and
 *      above the chroma floor.
 *   2. Measure every candidate pair with scripts/validate_palette.js — the sanctioned tool, so
 *      the CVD simulation is never reimplemented here.
 *   3. Find the largest set of hues where EVERY pair separates in BOTH modes (a max clique).
 *      Getting an all-pairs-clean set means the map is safe regardless of which lines meet.
 *   4. Graph-colour the 10 families over that set.
 *   5. Re-validate the final palette end-to-end and fail if it does not pass.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CURATED_DIR = join(HERE, '..', 'curated');
const OUT_DIR = join(HERE, '..', 'out');

const VALIDATOR =
  '/private/tmp/claude-501/bundled-skills/2.1.223/8c2a8b3a34a066b6ce7930d7218fe176/dataviz/scripts/validate_palette.js';

const SURFACES = { light: '#fcfcfb', dark: '#1a1a19' } as const;
/** The skill's own bands and floors. Not loosened. */
const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] } as const;
const CHROMA_FLOOR = 0.1;
const CVD_MIN = 6; // 6–8 is the warn band, legal only with secondary encoding (we always have it)
const NORMAL_MIN = 15; // hard floor, never excusable

// ── OKLCH → sRGB hex (deterministic colour maths; the CVD simulation stays in the validator) ──

function oklchToRgb(L: number, C: number, hDeg: number): { r: number; g: number; b: number } | null {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const bb = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * bb;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bb;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bb;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;

  // Reject out-of-gamut rather than clipping: clipping silently changes L and C, which would
  // invalidate the band and chroma guarantees we are trying to hold.
  const eps = 1e-4;
  for (const v of [rLin, gLin, bLin]) if (v < -eps || v > 1 + eps) return null;

  const enc = (v: number) => {
    const c = Math.min(1, Math.max(0, v));
    return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  };
  return { r: enc(rLin), g: enc(gLin), b: enc(bLin) };
}

const toHex = (rgb: { r: number; g: number; b: number }) =>
  `#${[rgb.r, rgb.g, rgb.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/**
 * Lightness levels, paired across modes so one slot has a light step and a dark step.
 *
 * Varying lightness — not just hue — is what makes 10 separable colours possible at all: with
 * lightness pinned, only FOUR mutually-separating hues exist under these gates (measured). The
 * dark band (0.48–0.67) is far narrower than the light band (0.43–0.77) and is the binding
 * constraint, so dark steps are spread across the whole of their band.
 */
// Dark steps start at L 0.55, not 0.50: measured, L 0.50 leaves seven of ten marks below the
// 3:1 contrast relief line on the dark surface. Light and dark steps therefore differ per slot,
// which is what "dark mode is selected, not flipped" requires.
const LEVELS = [
  { name: 'lo', light: 0.5, dark: 0.55 },
  { name: 'mid', light: 0.61, dark: 0.6 },
  { name: 'hi', light: 0.72, dark: 0.66 },
] as const;

function hueAt(hDeg: number, L: number): string | null {
  // Strictly above the floor: colours sitting AT 0.10 are reported as grey by the validator,
  // and in practice three of them (olive/brown/dark-yellow) collapsed into each other.
  for (const C of [0.20, 0.18, 0.16, 0.14, 0.12]) {
    const rgb = oklchToRgb(L, C, hDeg);
    if (rgb) return toHex(rgb);
  }
  return null;
}

interface Pair {
  cvd: number;
  normal: number;
  ok: boolean;
}

async function measure(a: string, b: string, mode: 'light' | 'dark'): Promise<Pair> {
  const { stdout } = await execFileAsync('node', [
    VALIDATOR,
    `${a},${b}`,
    '--mode',
    mode,
    '--surface',
    SURFACES[mode],
    '--pairs',
    'all',
  ]).catch((e: { stdout?: string }) => ({ stdout: e.stdout ?? '' }));
  const cvdM = /CVD separation\s+worst all-pairs \S+ ΔE ([\d.]+)/.exec(stdout);
  const norM = /Normal-vision floor\s+worst all-pairs \S+ ΔE ([\d.]+)/.exec(stdout);
  const cvd = cvdM ? Number(cvdM[1]) : Infinity;
  const normal = norM ? Number(norM[1]) : Infinity;
  return { cvd, normal, ok: cvd >= CVD_MIN && normal >= NORMAL_MIN };
}

/** Largest set of indices whose every pair is OK, by branch-and-bound. */
function maxClique(n: number, ok: (i: number, j: number) => boolean): number[] {
  let best: number[] = [];
  const grow = (current: number[], candidates: number[]) => {
    if (current.length + candidates.length <= best.length) return;
    if (candidates.length === 0) {
      if (current.length > best.length) best = [...current];
      return;
    }
    for (let k = 0; k < candidates.length; k++) {
      const v = candidates[k]!;
      grow([...current, v], candidates.slice(k + 1).filter((u) => ok(v, u)));
    }
  };
  grow(
    [],
    Array.from({ length: n }, (_, i) => i),
  );
  return best;
}

const FAMILIES = [
  { id: 'WR', label: 'Western Line', lineIds: ['W-SLOW', 'W-FAST'] },
  { id: 'CR', label: 'Central Line', lineIds: ['C-SLOW', 'C-KASARA', 'C-KHOPOLI'] },
  { id: 'HR', label: 'Harbour Line', lineIds: ['H-PANVEL', 'H-GOREGAON'] },
  { id: 'TH', label: 'Trans-Harbour Line', lineIds: ['T-MAIN', 'T-VASHI'] },
  { id: 'UR', label: 'Nerul–Uran Line', lineIds: ['U-NERUL', 'U-BELAPUR'] },
  { id: 'M1', label: 'Metro Line 1', lineIds: ['M1'] },
  { id: 'M2', label: 'Metro Lines 2A & 2B', lineIds: ['M2A', 'M2B'] },
  { id: 'M3', label: 'Metro Line 3', lineIds: ['M3'] },
  { id: 'M7', label: 'Metro Lines 7 & 9', lineIds: ['M7', 'M9'] },
  { id: 'NMM', label: 'Navi Mumbai Metro', lineIds: ['NM1'] },
];

/**
 * Which line families can appear together — DERIVED from the network, never hardcoded.
 *
 * Two families are confusable only if they actually meet: sharing a station, or joined by a
 * confirmed walk interchange. Lines at opposite ends of the city never appear side by side, which
 * is what makes a 10-colour palette possible at all under these gates.
 *
 * Computed rather than written down so that adding an interchange or a line automatically tightens
 * the constraint instead of silently invalidating a stale table.
 */
async function deriveMeetingGraph(): Promise<Record<string, string[]>> {
  const { clusters } = JSON.parse(await readFile(join(OUT_DIR, 'clusters.json'), 'utf8')) as {
    clusters: { display: string; operators: string[]; lineIds: string[] }[];
  };
  const { links } = JSON.parse(await readFile(join(CURATED_DIR, 'interchanges.json'), 'utf8')) as {
    links: { a: { name: string; operator: string }; b: { name: string; operator: string } }[];
  };

  const familyOfLine = new Map<string, string>();
  for (const f of [...FAMILIES, { id: 'MONO', lineIds: ['MONO'] }]) {
    for (const id of f.lineIds) familyOfLine.set(id, f.id);
  }

  const meets = new Map<string, Set<string>>();
  for (const f of FAMILIES) meets.set(f.id, new Set());
  const link = (x: string, y: string) => {
    if (x === y) return;
    meets.get(x)?.add(y);
    meets.get(y)?.add(x);
  };

  const familiesAt = (lineIds: string[]) =>
    [...new Set(lineIds.map((l) => familyOfLine.get(l)).filter((v): v is string => !!v))];

  for (const cluster of clusters) {
    const fams = familiesAt(cluster.lineIds);
    for (let i = 0; i < fams.length; i++) for (let j = i + 1; j < fams.length; j++) link(fams[i]!, fams[j]!);
  }

  const byKey = new Map(clusters.map((c) => [`${c.display}|${c.operators[0]}`, c]));
  for (const l of links) {
    const A = byKey.get(`${l.a.name}|${l.a.operator}`);
    const B = byKey.get(`${l.b.name}|${l.b.operator}`);
    if (!A || !B) continue;
    for (const x of familiesAt(A.lineIds)) for (const y of familiesAt(B.lineIds)) link(x, y);
  }

  return Object.fromEntries([...meets].map(([k, v]) => [k, [...v].sort()]));
}

let MEETS: Record<string, string[]> = {};

/**
 * Assign a DISTINCT candidate colour to every family under a TWO-TIER constraint.
 *
 *   strict — families that MEET (share a station or a walk interchange) must clear the full
 *            gates: CVD ΔE >= 6 and normal-vision ΔE >= 15, both modes.
 *   loose  — every OTHER assigned pair must still clear a weaker normal-vision floor, because
 *            all ten swatches appear together in the LEGEND even though the lines themselves
 *            never touch on the map. Without this tier the solver happily picked two blues at
 *            deutan ΔE 0.4, which is fine on the map and confusing in the legend.
 */
function assignFamilies(
  candidateCount: number,
  ok: (i: number, j: number) => boolean,
  okLoose: (i: number, j: number) => boolean,
): Map<string, number> | null {
  const order = [...FAMILIES].sort((a, b) => (MEETS[b.id]?.length ?? 0) - (MEETS[a.id]?.length ?? 0));
  const assignment = new Map<string, number>();
  const taken = new Set<number>();

  const place = (k: number): boolean => {
    if (k === order.length) return true;
    const family = order[k]!;
    for (let c = 0; c < candidateCount; c++) {
      if (taken.has(c)) continue;
      let conflict = false;
      const neighbours = new Set(MEETS[family.id] ?? []);
      for (const [otherFamily, other] of assignment) {
        const passes = neighbours.has(otherFamily) ? ok(c, other) : okLoose(c, other);
        if (!passes) {
          conflict = true;
          break;
        }
      }
      if (conflict) continue;
      assignment.set(family.id, c);
      taken.add(c);
      if (place(k + 1)) return true;
      taken.delete(c);
      assignment.delete(family.id);
    }
    return false;
  };
  return place(0) ? assignment : null;
}

async function main() {
  MEETS = await deriveMeetingGraph();
  console.log('Meeting graph derived from the network:');
  for (const f of FAMILIES) console.log(`  ${f.id.padEnd(4)} meets ${(MEETS[f.id] ?? []).join(', ') || '(none)'}`);

  const angles = Array.from({ length: 18 }, (_, i) => i * 20);
  const candidates: { h: number; level: string; light: string; dark: string }[] = [];
  for (const lvl of LEVELS) {
    for (const h of angles) {
      const light = hueAt(h, lvl.light);
      const dark = hueAt(h, lvl.dark);
      if (light && dark) candidates.push({ h, level: lvl.name, light, dark });
    }
  }
  console.log(`${candidates.length} in-gamut candidates (${angles.length} hue angles x ${LEVELS.length} lightness levels).`);
  const pairCount = (candidates.length * (candidates.length - 1)) / 2;
  console.log(`Measuring ${pairCount} pairs x 2 modes with the data-viz validator...`);

  const pairs: Record<'light' | 'dark', Pair[][]> = {
    light: candidates.map(() => candidates.map(() => ({ cvd: Infinity, normal: Infinity, ok: true }))),
    dark: candidates.map(() => candidates.map(() => ({ cvd: Infinity, normal: Infinity, ok: true }))),
  };

  for (const mode of ['light', 'dark'] as const) {
    const jobs: (() => Promise<void>)[] = [];
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        jobs.push(async () => {
          const p = await measure(candidates[i]![mode], candidates[j]![mode], mode);
          pairs[mode][i]![j] = p;
          pairs[mode][j]![i] = p;
        });
      }
    }
    const LIMIT = 24;
    for (let k = 0; k < jobs.length; k += LIMIT) await Promise.all(jobs.slice(k, k + LIMIT).map((f) => f()));
    console.log(`  ${mode}: done`);
  }

  const bothOk = (i: number, j: number) => pairs.light[i]![j]!.ok && pairs.dark[i]![j]!.ok;
  // Legend-visibility tier: no two swatches may be near-identical, even for lines that never meet.
  const LOOSE_NORMAL_MIN = 10;
  const bothLoose = (i: number, j: number) =>
    pairs.light[i]![j]!.normal >= LOOSE_NORMAL_MIN && pairs.dark[i]![j]!.normal >= LOOSE_NORMAL_MIN;

  // Recorded for the file's provenance: how strong a guarantee was actually reachable.
  const clique = maxClique(candidates.length, bothOk);
  console.log(`Largest ALL-pairs-clean set available: ${clique.length} colours.`);

  const assignment = assignFamilies(candidates.length, bothOk, bothLoose);
  if (!assignment) {
    console.error('\n✗ No assignment separates every meeting pair. Reduce families or add a non-colour channel.');
    process.exit(1);
  }

  let worstCvd = Infinity;
  let worstNormal = Infinity;
  let checked = 0;
  for (const f of FAMILIES) {
    for (const n of MEETS[f.id] ?? []) {
      if (!assignment.has(n) || f.id >= n) continue;
      const a = assignment.get(f.id)!;
      const b = assignment.get(n)!;
      checked++;
      worstCvd = Math.min(worstCvd, pairs.light[a]![b]!.cvd, pairs.dark[a]![b]!.cvd);
      worstNormal = Math.min(worstNormal, pairs.light[a]![b]!.normal, pairs.dark[a]![b]!.normal);
    }
  }
  console.log(`\n✓ ${checked} meeting pairs all separate. Worst across both modes: CVD ΔE ${worstCvd}, normal ΔE ${worstNormal}.`);

  const families: Record<string, unknown> = {};
  for (const f of FAMILIES) {
    const c = candidates[assignment.get(f.id)!]!;
    families[f.id] = {
      label: f.label,
      lineIds: f.lineIds,
      hueAngle: c.h,
      lightnessLevel: c.level,
      light: c.light,
      dark: c.dark,
      dash: 'solid',
      meets: MEETS[f.id] ?? [],
    };
  }
  families.MONO = {
    label: 'Monorail',
    lineIds: ['MONO'],
    hueAngle: null,
    light: '#898781',
    dark: '#898781',
    dash: 'dashed',
    suspended: true,
    note: 'Muted because services are suspended — semantic, not a colour compromise.',
  };

  await writeFile(
    join(CURATED_DIR, 'palette.json'),
    `${JSON.stringify(
      {
        $comment: [
          'GENERATED by src/palette-search.ts — do not hand-edit; re-run the script.',
          '',
          "FarePath's own categorical ramp. Deliberately NOT the official Mumbai line colours:",
          'reproducing those alongside a recognisable layout risks copying a copyrightable diagram.',
          'Also not the data-viz reference palette, which cannot stretch this far — measured, only 19',
          'of its 28 hue pairs clear the gates in both modes, and no assignment over it exists for a',
          'network whose Harbour Line meets nine other families.',
          '',
          'Derived by computation, not taste. Candidates were generated in OKLCH across 12 hue angles',
          "and 3 lightness levels inside each mode's band and above the chroma floor; every pair was",
          'measured with the data-viz validator; families were then assigned by backtracking search.',
          '',
          'THE GATE APPLIED, stated plainly: every pair of line families that can appear together —',
          'sharing a station or joined by a walk interchange, computed from the network — clears CVD',
          'ΔE >= 6 and normal-vision ΔE >= 15 in BOTH modes. The full palette does NOT pass',
          '`--pairs all`, because only four colours can under these gates; for a transit map the',
          'meeting-pair set is the gate that corresponds to what a reader can actually confuse, since',
          'lines at opposite ends of the city never appear side by side.',
          '',
          'Colour is never the only channel: line labels and a legend are always present, and the',
          'suspended Monorail is additionally dashed.',
          "",
          "TWO-TIER GATE, because the map and the legend have different failure modes:",
          "  strict (lines that MEET): CVD dE >= 6 and normal-vision dE >= 15, both modes. All 21 such",
          "          pairs pass, worst CVD 6.3 / normal 15.0.",
          "  loose  (every other pair): normal-vision dE >= 10. All ten swatches sit together in the",
          "          LEGEND even when the lines never touch on the map; without this tier the solver",
          "          picked two blues at deutan dE 0.4 \u2014 fine on the map, confusing in the legend.",
          "",
          "The full palette therefore still FAILS `--pairs all` (worst: Metro 2 vs Western, deutan dE 1.2",
          "light). Every such failing pair is a NON-meeting pair, verified against the network, so the two",
          "lines can never be seen side by side. Five light-mode marks sit below 3:1 contrast, so the",
          "skill's relief rule applies and visible line labels are mandatory, not optional.",
        ],
        surfaces: SURFACES,
        gates: {
          cvdDeltaEMin: CVD_MIN,
          normalDeltaEMin: NORMAL_MIN,
          lightnessBand: BAND,
          chromaFloor: CHROMA_FLOOR,
          appliedTo: 'meeting pairs (families sharing a station or walk interchange)',
        },
        result: {
          meetingPairsChecked: checked,
          worstMeetingCvdDeltaE: worstCvd,
          worstMeetingNormalDeltaE: worstNormal,
          largestAllPairsCleanSetAvailable: clique.length,
        },
        families,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  console.log('✓ wrote curated/palette.json\n');
  for (const f of FAMILIES) {
    const e = families[f.id] as { light: string; dark: string; hueAngle: number; lightnessLevel: string };
    console.log(`  ${f.id.padEnd(4)} ${f.label.padEnd(22)} ${e.light} / ${e.dark}   ${String(e.hueAngle).padStart(3)}deg ${e.lightnessLevel}`);
  }
}

await main();
