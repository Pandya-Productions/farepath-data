/**
 * Schematic map layout.
 *
 *   node --experimental-strip-types src/layout.ts
 *
 * Writes layout coordinates into the shipped dataset and renders out/layout.svg so the diagram
 * can be reviewed in a browser with no app running.
 *
 * ── Why this approach ──
 *
 * A true octilinear metro diagram (every segment at a multiple of 45°, stations evenly spaced,
 * labels placed without collision) is a global optimisation problem, and solving it badly looks
 * far worse than not attempting it. So the layout is split into a part that is safe to automate
 * and a part that is left to a human:
 *
 *   automated  — geographic projection, overlap relaxation, and OCTILINEAR CONNECTORS: every
 *                segment is drawn as run → 45° diagonal → run. That produces the schematic look
 *                while every station stays at its true relative position, so the map cannot lie
 *                about where a station is.
 *   manual     — `curated/layout-overrides.json`, applied last, for the handful of places where
 *                geography crowds (South Mumbai, the Dadar and Andheri clusters).
 *
 * The design is deliberately NOT a redraw of the official Mumbai map: original palette (see
 * palette.json) and original geometry, because reproducing the official diagram's look alongside
 * its layout risks copying a copyrightable work.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TransitNetwork } from '../types/network.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'out');
const CURATED_DIR = join(HERE, '..', 'curated');
const ASSET_DIR = join(HERE, '..', '..', '..', 'apps', 'mobile', 'assets');

/** Canvas in layout units. Mumbai is tall and narrow, so the canvas is portrait. */
const CANVAS = { width: 1000, height: 1500, margin: 60 };
/** Minimum gap between station centres, so markers and labels have room. */
const MIN_SEPARATION = 13;
const RELAX_ITERATIONS = 260;

interface Point {
  x: number;
  y: number;
}

/** Web Mercator. At Mumbai's latitude the y-stretch is mild but worth keeping honest. */
function mercator(lat: number, lon: number): Point {
  const x = (lon * Math.PI) / 180;
  const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return { x, y };
}

/**
 * Compress distance from the centre so the dense core stays readable.
 *
 * Geographically honest scaling is unusable here: Kasara is 121 km from CSMT and Khopoli 114 km,
 * so a linear map spends most of its canvas on two branch lines and squeezes all of Mumbai city
 * into a corner. Real transit maps distort exactly this way.
 *
 * r' = rMax · (r / rMax)^GAMMA — the core barely moves while the outer termini pull in hard.
 * Direction from the centre is preserved, so nothing ends up on the wrong side of the city.
 */
const COMPRESSION_GAMMA = 0.62;

function compressRadially(points: { id: number; x: number; y: number }[]): void {
  // Median centre, so the far branches do not drag the origin outward.
  const median = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)]!;
  };
  const cx = median(points.map((p) => p.x));
  const cy = median(points.map((p) => p.y));
  const radii = points.map((p) => Math.hypot(p.x - cx, p.y - cy));
  const rMax = Math.max(...radii);
  if (rMax <= 0) return;

  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const r = Math.hypot(dx, dy);
    if (r < 1e-12) continue;
    const compressed = rMax * (r / rMax) ** COMPRESSION_GAMMA;
    const factor = compressed / r;
    p.x = cx + dx * factor;
    p.y = cy + dy * factor;
  }
}

/**
 * Push overlapping stations apart.
 *
 * Bounded on purpose: a station may drift, but the relaxation is gentle and symmetric so the
 * network keeps its real shape. Letting stations move freely would produce a prettier diagram
 * that misrepresents where things are.
 */
function relax(points: Map<number, Point>): { moved: number; maxShift: number } {
  const ids = [...points.keys()];
  const original = new Map([...points].map(([id, p]) => [id, { ...p }]));

  for (let iter = 0; iter < RELAX_ITERATIONS; iter++) {
    let anyOverlap = false;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = points.get(ids[i]!)!;
        const b = points.get(ids[j]!)!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= MIN_SEPARATION) continue;
        anyOverlap = true;
        if (d < 1e-6) {
          // Exactly coincident: nudge deterministically so runs are reproducible.
          dx = (i % 2 === 0 ? 1 : -1) * 0.5;
          dy = 0.5;
          d = Math.hypot(dx, dy);
        }
        const push = (MIN_SEPARATION - d) / 2 / d;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
      }
    }
    if (!anyOverlap) break;
  }

  let moved = 0;
  let maxShift = 0;
  for (const id of ids) {
    const shift = Math.hypot(points.get(id)!.x - original.get(id)!.x, points.get(id)!.y - original.get(id)!.y);
    if (shift > 0.5) moved++;
    maxShift = Math.max(maxShift, shift);
  }
  return { moved, maxShift };
}

/**
 * Octilinear connector: a straight run, a 45° diagonal, then a straight run. This is what makes
 * the diagram read as a transit map rather than a scatter of dots joined by arbitrary angles.
 */
function octilinear(a: Point, b: Point): Point[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 0.5 || ady < 0.5 || Math.abs(adx - ady) < 0.5) return [a, b];

  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  if (adx > ady) {
    const run = (adx - ady) / 2;
    return [a, { x: a.x + sx * run, y: a.y }, { x: b.x - sx * run, y: b.y }, b];
  }
  const run = (ady - adx) / 2;
  return [a, { x: a.x, y: a.y + sy * run }, { x: b.x, y: b.y - sy * run }, b];
}

/** XML-escape text destined for SVG. Station names contain '&' (VNP & RC Marg Junction). */
const esc = (t: string) =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');


/**
 * Greedy label placement with collision avoidance.
 *
 * Tries a few offsets per station and keeps the first that does not overlap an already-placed
 * label, otherwise drops the label. Dropping is the right failure mode for a review render: an
 * unreadable pile of overlapping text hides problems, a missing label does not. The app itself
 * reveals labels progressively by zoom level instead.
 */
interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function placeLabels(
  entries: { id: number; text: string; at: Point; priority: number }[],
  fontSize: number,
): { text: string; x: number; y: number; anchor: 'start' | 'end' | 'middle' }[] {
  const CHAR_W = fontSize * 0.55;
  const placed: LabelBox[] = [];
  const out: { text: string; x: number; y: number; anchor: 'start' | 'end' | 'middle' }[] = [];

  const overlaps = (b: LabelBox) =>
    placed.some((q) => b.x < q.x + q.w && q.x < b.x + b.w && b.y < q.y + q.h && q.y < b.y + b.h);

  // Most-connected stations get first pick of the good positions.
  for (const entry of [...entries].sort((a, b) => b.priority - a.priority)) {
    const w = entry.text.length * CHAR_W;
    const h = fontSize + 1.5;
    const options: { x: number; y: number; anchor: 'start' | 'end' | 'middle'; box: LabelBox }[] = [
      { x: entry.at.x + 7, y: entry.at.y + fontSize * 0.36, anchor: 'start', box: { x: entry.at.x + 7, y: entry.at.y - h / 2, w, h } },
      { x: entry.at.x - 7, y: entry.at.y + fontSize * 0.36, anchor: 'end', box: { x: entry.at.x - 7 - w, y: entry.at.y - h / 2, w, h } },
      { x: entry.at.x, y: entry.at.y - 8, anchor: 'middle', box: { x: entry.at.x - w / 2, y: entry.at.y - 8 - h, w, h } },
      { x: entry.at.x, y: entry.at.y + 13, anchor: 'middle', box: { x: entry.at.x - w / 2, y: entry.at.y + 13 - h, w, h } },
    ];
    const choice = options.find((o) => !overlaps(o.box));
    if (!choice) continue;
    placed.push(choice.box);
    out.push({ text: entry.text, x: choice.x, y: choice.y, anchor: choice.anchor });
  }
  return out;
}

const path = (pts: Point[]) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');

async function main() {
  const network: TransitNetwork = JSON.parse(await readFile(join(OUT_DIR, 'transit.json'), 'utf8'));
  const palette = JSON.parse(await readFile(join(CURATED_DIR, 'palette.json'), 'utf8')) as {
    surfaces: { light: string; dark: string };
    families: Record<string, { label: string; lineIds: string[]; light: string; dark: string; dash: string; suspended?: boolean }>;
  };

  const overridePath = join(CURATED_DIR, 'layout-overrides.json');
  const overrides: Record<string, { x: number; y: number; reason?: string }> = existsSync(overridePath)
    ? JSON.parse(await readFile(overridePath, 'utf8')).stations ?? {}
    : {};

  // ── project ───────────────────────────────────────────────────────────────
  const projected = network.stations.map((s) => ({ id: s.id, ...mercator(s.lat, s.lon) }));
  compressRadially(projected);
  const xs = projected.map((p) => p.x);
  const ys = projected.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const usableW = CANVAS.width - CANVAS.margin * 2;
  const usableH = CANVAS.height - CANVAS.margin * 2;
  // One scale for both axes so the map is not stretched.
  const scale = Math.min(usableW / (maxX - minX), usableH / (maxY - minY));
  const offsetX = CANVAS.margin + (usableW - (maxX - minX) * scale) / 2;
  const offsetY = CANVAS.margin + (usableH - (maxY - minY) * scale) / 2;

  const points = new Map<number, Point>();
  for (const p of projected) {
    points.set(p.id, {
      x: offsetX + (p.x - minX) * scale,
      // Flip y: Mercator grows north, SVG grows down.
      y: offsetY + (maxY - p.y) * scale,
    });
  }

  const { moved, maxShift } = relax(points);

  // Manual overrides win, applied last.
  const stationsByName = new Map(network.stations.map((s) => [`${s.name}|${s.operatorId}`, s.id]));
  let applied = 0;
  for (const [key, pos] of Object.entries(overrides)) {
    const id = stationsByName.get(key);
    if (id === undefined) {
      console.warn(`  ⚠ layout override for unknown station '${key}' — ignored`);
      continue;
    }
    points.set(id, { x: pos.x, y: pos.y });
    applied++;
  }

  // ── colours ───────────────────────────────────────────────────────────────
  const styleOfLine = new Map<string, { light: string; dark: string; dash: string; suspended: boolean }>();
  for (const fam of Object.values(palette.families)) {
    for (const id of fam.lineIds) {
      styleOfLine.set(id, { light: fam.light, dark: fam.dark, dash: fam.dash, suspended: !!fam.suspended });
    }
  }

  // ── build line polylines from edges (each line's own station order) ────────
  const stationsOfLine = new Map<string, number[]>();
  for (const line of network.lines) {
    // Reconstruct the order by walking the line's edges from an endpoint.
    const adjacency = new Map<number, number[]>();
    for (const e of network.edges) {
      if (e.lineId !== line.id) continue;
      (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
    }
    if (adjacency.size === 0) continue;
    const endpoints = [...adjacency].filter(([, to]) => to.length === 1).map(([from]) => from);
    const start = endpoints[0] ?? [...adjacency.keys()][0]!;
    const order: number[] = [start];
    const seen = new Set([start]);
    for (;;) {
      const next = (adjacency.get(order[order.length - 1]!) ?? []).find((n) => !seen.has(n));
      if (next === undefined) break;
      order.push(next);
      seen.add(next);
    }
    stationsOfLine.set(line.id, order);
  }

  // ── emit layout into the dataset ──────────────────────────────────────────
  const layout = {
    canvas: CANVAS,
    stations: Object.fromEntries(
      [...points].map(([id, p]) => [id, { x: Number(p.x.toFixed(1)), y: Number(p.y.toFixed(1)) }]),
    ),
    lines: Object.fromEntries(
      [...stationsOfLine].map(([lineId, order]) => [
        lineId,
        {
          order,
          // Pre-computed octilinear polyline so the app does no layout work at runtime.
          points: order
            .flatMap((id, i) =>
              i === 0 ? [points.get(id)!] : octilinear(points.get(order[i - 1]!)!, points.get(id)!).slice(1),
            )
            .map((p) => [Number(p.x.toFixed(1)), Number(p.y.toFixed(1))]),
        },
      ]),
    ),
  };

  await writeFile(join(OUT_DIR, 'layout.json'), JSON.stringify(layout), 'utf8');
  // Only when the app is present — see the same note in build.ts.
  const appPresent = existsSync(dirname(ASSET_DIR));
  if (appPresent) await writeFile(join(ASSET_DIR, 'layout.json'), JSON.stringify(layout), 'utf8');

  // ── render the review SVG ─────────────────────────────────────────────────
  const interchangeIds = new Set<number>();
  for (const s of network.stations) if (s.lineIds.length > 1) interchangeIds.add(s.id);
  for (const i of network.interchanges) (interchangeIds.add(i.a), interchangeIds.add(i.b));

  const nameById = new Map(network.stations.map((s) => [s.id, s.shortName ?? s.name]));
  const termini = new Set<number>();
  for (const order of stationsOfLine.values()) {
    if (order.length > 0) (termini.add(order[0]!), termini.add(order[order.length - 1]!));
  }

  const svgLines: string[] = [];
  for (const line of network.lines) {
    const order = stationsOfLine.get(line.id);
    const style = styleOfLine.get(line.id);
    if (!order || !style || order.length < 2) continue;
    const pts = order.flatMap((id, i) =>
      i === 0 ? [points.get(id)!] : octilinear(points.get(order[i - 1]!)!, points.get(id)!).slice(1),
    );
    svgLines.push(
      `<path d="${path(pts)}" fill="none" stroke="${style.light}" stroke-width="3.2" ` +
        `stroke-linejoin="round" stroke-linecap="round" opacity="${style.suspended ? 0.5 : 0.95}"` +
        `${style.dash === 'dashed' ? ' stroke-dasharray="7 5"' : ''}><title>${esc(line.name)}</title></path>`,
    );
  }

  const svgStations: string[] = [];
  const svgLabels: string[] = [];
  for (const s of network.stations) {
    const p = points.get(s.id)!;
    const isInterchange = interchangeIds.has(s.id);
    const suspended = styleOfLine.get(s.lineIds[0] ?? '')?.suspended;
    svgStations.push(
      isInterchange
        ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.6" fill="${palette.surfaces.light}" stroke="#0b0b0b" stroke-width="1.9" opacity="${suspended ? 0.55 : 1}"><title>${esc(s.name)}</title></circle>`
        : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.5" fill="#0b0b0b" opacity="${suspended ? 0.45 : 0.85}"><title>${esc(s.name)}</title></circle>`,
    );
  }

  // Label only interchanges and termini in the review render — the app reveals the rest by zoom,
  // and 218 labels at once is illegible.
  const LABEL_FONT = 7.4;
  const labelEntries: { id: number; text: string; at: Point; priority: number }[] = [];
  const labelledNames = new Map<string, Point>();
  for (const s of network.stations) {
    if (!interchangeIds.has(s.id) && !termini.has(s.id)) continue;
    const at = points.get(s.id)!;
    // Two stations can legitimately share a name across operators (Ghatkopar, Marol Naka,
    // Chembur). Label the pair once — the second label adds noise, not information.
    const seen = labelledNames.get(s.name);
    if (seen && Math.hypot(seen.x - at.x, seen.y - at.y) < 34) continue;
    labelledNames.set(s.name, at);
    labelEntries.push({ id: s.id, text: nameById.get(s.id)!, at, priority: s.lineIds.length });
  }
  for (const label of placeLabels(labelEntries, LABEL_FONT)) {
    svgLabels.push(
      `<text x="${label.x.toFixed(1)}" y="${label.y.toFixed(1)}" font-size="${LABEL_FONT}" ` +
        `text-anchor="${label.anchor}" fill="#0b0b0b" ` +
        `font-family="system-ui,-apple-system,sans-serif">${esc(label.text)}</text>`,
    );
  }

  const legendEntries = Object.entries(palette.families);
  const legend = legendEntries
    .map(([, fam], i) => {
      const y = 34 + i * 17;
      return (
        `<line x1="14" y1="${y}" x2="42" y2="${y}" stroke="${fam.light}" stroke-width="3.2" ` +
        `${fam.dash === 'dashed' ? 'stroke-dasharray="7 5" ' : ''}stroke-linecap="round"/>` +
        `<text x="50" y="${y + 3.4}" font-size="9.4" fill="#0b0b0b" font-family="system-ui,-apple-system,sans-serif">` +
        `${esc(fam.label)}${fam.suspended ? ' (suspended)' : ''}</text>`
      );
    })
    .join('');

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}" width="${CANVAS.width}" height="${CANVAS.height}">
<rect width="100%" height="100%" fill="${palette.surfaces.light}"/>
<g>${svgLines.join('\n')}</g>
<g>${svgStations.join('\n')}</g>
<g>${svgLabels.join('\n')}</g>
<g><rect x="6" y="16" width="228" height="${28 + legendEntries.length * 17}" fill="${palette.surfaces.light}" stroke="#e1e0d9"/>
<text x="14" y="${16 + 14}" font-size="10.5" font-weight="600" fill="#0b0b0b" font-family="system-ui,-apple-system,sans-serif">Lines</text>
${legend}</g>
<text x="14" y="${CANVAS.height - 26}" font-size="8.4" fill="#52514e" font-family="system-ui,-apple-system,sans-serif">Station and route data © OpenStreetMap contributors, ODbL 1.0.</text>
<text x="14" y="${CANVAS.height - 14}" font-size="8.4" fill="#52514e" font-family="system-ui,-apple-system,sans-serif">Not affiliated with or endorsed by MMRDA, MMRC, MMOPL, MMMOCL, CIDCO or Indian Railways.</text>
</svg>
`;

  await writeFile(join(OUT_DIR, 'layout.svg'), svg, 'utf8');

  console.log(`\nLAYOUT`);
  console.log(`  canvas          ${CANVAS.width} × ${CANVAS.height}`);
  console.log(`  stations placed ${points.size}`);
  console.log(`  relaxation      ${moved} stations nudged, max shift ${maxShift.toFixed(1)} units`);
  console.log(`  overrides       ${applied} applied${applied === 0 ? ' (none needed yet)' : ''}`);
  console.log(`  lines drawn     ${stationsOfLine.size}`);
  console.log(`  labelled        ${svgLabels.length} of ${labelEntries.length} candidates (collision-avoided)`);
  const layoutKb = Buffer.byteLength(JSON.stringify(layout)) / 1024;
  console.log(`  layout.json     ${layoutKb.toFixed(1)} KB`);
  console.log(`\n✓ wrote out/layout.json, out/layout.svg${appPresent ? ' and apps/mobile/assets/layout.json' : ''}`);
  console.log(`  review it: open ${join(OUT_DIR, 'layout.svg')}`);
}

await main();
