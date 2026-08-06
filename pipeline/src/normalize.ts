/**
 * Station name resolution and normalisation.
 *
 * Three distinct names per station, and conflating them causes bugs:
 *   - display : what the user reads ("Chhatrapati Shivaji Maharaj Terminus")
 *   - short   : optional compact label for the map ("CSMT")
 *   - norm    : matching key, never shown ("chhatrapatishivajimaharaj")
 *
 * `norm` is used for search and as one half of the interchange-clustering test. It is
 * deliberately NOT aggressive: transliteration variants (Vadala/Wadala) are handled by
 * explicit curated aliases, because folding v↔w or collapsing doubled letters risks
 * colliding genuinely different Mumbai station names.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OsmNode } from './osm-types.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CURATED_DIR = join(HERE, '..', 'curated');

interface NameOverrides {
  nodeNames: Record<string, { name: string; reason: string; evidence?: string } | unknown>;
  stripSuffixes: { parenthetical: string[]; trailingWords: string[]; bracketedPatterns?: string[] };
  displayNames: Record<string, { name: string; short?: string; reason: string } | unknown>;
  aliases: Record<string, string[] | unknown>;
  normStopWords: { words: string[] };
}

export interface Overrides {
  nodeNames: Map<number, { name: string; reason: string }>;
  parenthetical: Set<string>;
  trailingWords: string[];
  /** Compiled patterns matched against the CONTENTS of a [..] group. */
  bracketed: RegExp[];
  displayNames: Map<string, { name: string; short?: string }>;
  aliases: Map<string, string[]>;
  stopWords: string[];
}

export async function loadOverrides(): Promise<Overrides> {
  const raw = JSON.parse(await readFile(join(CURATED_DIR, 'name-overrides.json'), 'utf8')) as NameOverrides;

  const nodeNames = new Map<number, { name: string; reason: string }>();
  for (const [id, value] of Object.entries(raw.nodeNames)) {
    if (id.startsWith('$') || typeof value !== 'object' || value === null) continue;
    const v = value as { name?: string; reason?: string };
    if (v.name) nodeNames.set(Number(id), { name: v.name, reason: v.reason ?? '' });
  }

  const displayNames = new Map<string, { name: string; short?: string }>();
  for (const [key, value] of Object.entries(raw.displayNames)) {
    if (key.startsWith('$') || typeof value !== 'object' || value === null) continue;
    const v = value as { name?: string; short?: string };
    if (v.name) displayNames.set(key, { name: v.name, short: v.short });
  }

  const aliases = new Map<string, string[]>();
  for (const [key, value] of Object.entries(raw.aliases)) {
    if (key.startsWith('$') || !Array.isArray(value)) continue;
    aliases.set(key, value as string[]);
  }

  return {
    nodeNames,
    parenthetical: new Set(raw.stripSuffixes.parenthetical),
    trailingWords: raw.stripSuffixes.trailingWords,
    bracketed: (raw.stripSuffixes.bracketedPatterns ?? []).map((p) => new RegExp(p)),
    displayNames,
    aliases,
    stopWords: raw.normStopWords.words,
  };
}

export interface ResolvedName {
  display: string;
  short?: string;
  norm: string;
  /** How the raw name was obtained — 'curated' and 'ref-fallback' both warrant review. */
  source: 'osm-name' | 'curated' | 'osm-name-en' | 'ref-fallback';
  rawOsmName?: string;
}

/**
 * Resolve a stop node to a usable name.
 *
 * Resolution order matters: a curated override wins over OSM, because overrides exist
 * precisely to fix OSM defects (e.g. node 631525335 / Matunga Road carries name:hi and
 * ref=MRU but no `name` tag, and would otherwise vanish from the graph entirely).
 */
export function resolveName(node: OsmNode, overrides: Overrides): ResolvedName | null {
  const tags = node.tags ?? {};

  const curated = overrides.nodeNames.get(node.id);
  if (curated) return finalise(curated.name, overrides, 'curated', tags.name);

  if (tags.name) return finalise(tags.name, overrides, 'osm-name', tags.name);
  if (tags['name:en']) return finalise(tags['name:en'], overrides, 'osm-name-en', tags['name:en']);
  // A bare ref like "MRU" is not a usable display name; return it so the caller can flag
  // it loudly for curation rather than shipping a station called "MRU".
  if (tags.ref) return finalise(tags.ref, overrides, 'ref-fallback', undefined);

  return null;
}

function finalise(
  rawName: string,
  overrides: Overrides,
  source: ResolvedName['source'],
  rawOsmName?: string,
): ResolvedName {
  const replacement = overrides.displayNames.get(rawName);
  if (replacement) {
    return {
      display: replacement.name,
      short: replacement.short,
      norm: normaliseName(replacement.name, overrides),
      source: 'curated',
      rawOsmName: rawOsmName ?? rawName,
    };
  }

  const display = stripDisambiguators(rawName, overrides);
  return { display, norm: normaliseName(display, overrides), source, rawOsmName };
}

/**
 * Remove qualifiers that exist only to disambiguate OSM nodes, e.g.
 * "Marol Naka (Line 3)" → "Marol Naka", "Jagannath Shankar Sheth Metro" → "Jagannath Shankar Sheth".
 *
 * Only suffixes on the curated allowlist are stripped. Stripping any parenthetical would
 * damage legitimate names, and Mumbai has stations whose brackets are part of the name.
 */
export function stripDisambiguators(name: string, overrides: Overrides): string {
  let out = name;

  out = out.replace(/\s*\(([^)]*)\)/g, (match, inner: string) =>
    overrides.parenthetical.has(inner.trim()) ? '' : match,
  );

  // Square brackets are OSM's way of separating shared-name metro platforms, e.g.
  // "Dahisar (East) [Line 2]" / "[Line 7]" / "[Line 9]" are three nodes for ONE interchange.
  // Only bracket contents matching a curated pattern are stripped, so a bracket that is part
  // of a genuine name survives.
  out = out.replace(/\s*\[([^\]]*)\]/g, (match, inner: string) =>
    overrides.bracketed.some((re) => re.test(inner.trim())) ? '' : match,
  );

  for (const word of overrides.trailingWords) {
    const re = new RegExp(`\\s+${word}$`, 'i');
    out = out.replace(re, '');
  }

  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Build the matching key: lowercase, strip punctuation and diacritics, drop curated stop
 * words ("junction", "terminus") so "Kalyan" matches "Kalyan Junction", remove whitespace.
 */
export function normaliseName(name: string, overrides: Overrides): string {
  let out = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // combining diacritical marks
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ');

  for (const word of overrides.stopWords) {
    out = out.replace(new RegExp(`\\b${word}\\b`, 'g'), ' ');
  }

  return out.replace(/\s+/g, '');
}

/** Search aliases for a resolved display name, normalised for matching. */
export function aliasesFor(display: string, overrides: Overrides): string[] {
  return overrides.aliases.get(display) ?? [];
}
