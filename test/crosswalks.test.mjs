import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { assertActiveFrameworkId, buildCrosswalks } from "../scripts/build-crosswalks.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const RETIRED = [
  "ru-149fz",
  "ru-152fz",
  "ru-242fz",
  "ru-ai-framework",
  "ru-gost-crypto",
  "ru-rkn",
  "gdpr-vs-ru-152fz",
];

function read(name) {
  return JSON.parse(readFileSync(join(DATA, name), "utf8"));
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch !== "\r") field += ch;
  }
  if (quoted) throw new Error("unclosed CSV quote");
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function findAuditScript(start) {
  let cursor = start;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cursor, "scripts", "audit-public-ip.mjs");
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return null;
}

test("retired and malformed framework ids are rejected", () => {
  assert.equal(assertActiveFrameworkId("gdpr"), "gdpr");
  assert.throws(() => assertActiveFrameworkId("ru-152fz"), /retired framework id: ru-152fz/);
  assert.throws(() => assertActiveFrameworkId("ru-149fz"), /retired framework id/);
  assert.throws(() => assertActiveFrameworkId("NOT AN ID"), /malformed framework id/);
  assert.throws(() => assertActiveFrameworkId(""), /malformed framework id/);
  assert.throws(() => assertActiveFrameworkId("gdpr/../etc"), /malformed framework id/);
});

test("committed crosswalk outputs match the active registry", () => {
  const frameworks = read("frameworks.json");
  const sectors = read("sectors.json");
  const crosswalks = read("crosswalks.json");
  const csvText = readFileSync(join(DATA, "crosswalks.csv"), "utf8");
  assert.equal(frameworks.length, 95);
  assert.equal(new Set(frameworks.map((item) => item.id)).size, 95);
  assert.equal(sectors.length, 11);
  const blob = JSON.stringify({ frameworks, sectors, crosswalks }) + csvText;
  for (const retired of RETIRED) {
    assert.equal(blob.includes(retired), false, retired);
  }
  for (const item of frameworks) {
    assert.match(item.canonicalUrl, /^https:\/\/presencis\.com\/regulations\/[a-z0-9-]+\/$/);
    assert.equal(item.canonicalUrl, `https://presencis.com/regulations/${item.id}/`);
    assert.equal(item.id.startsWith("ru-"), false);
    assert.ok(Array.isArray(item.sectors));
    if (item.officialText != null) assert.match(item.officialText, /^https:\/\//);
    if (item.wikidataQid != null) assert.match(item.wikidataQid, /^Q[1-9][0-9]*$/);
  }
  const active = new Set(frameworks.map((item) => item.id));
  for (const sector of sectors) {
    assert.equal(new Set(sector.regulations).size, sector.regulations.length);
    for (const id of sector.regulations) assert.ok(active.has(id), id);
  }
  for (const item of crosswalks.comparisons) {
    assert.ok(active.has(item.sourceId), item.sourceId);
    assert.ok(active.has(item.targetId), item.targetId);
    assert.match(item.canonicalUrl, /^https:\/\/presencis\.com\/comparisons\/[a-z0-9-]+\/$/);
  }
  for (const item of crosswalks.sectorCooccurrence) {
    assert.ok(active.has(item.sourceId));
    assert.ok(active.has(item.targetId));
    assert.ok(item.sourceId < item.targetId);
    assert.ok(item.sectors.length >= 1);
  }
  const rows = parseCsv(csvText);
  const width = rows[0].length;
  assert.deepEqual(rows[0], ["kind", "source_id", "target_id", "title", "summary", "sectors", "canonical_url"]);
  assert.ok(rows.length > 1);
  for (const row of rows) assert.equal(row.length, width);
  const comparisonRows = rows.slice(1).filter((row) => row[0] === "comparison");
  const overlapRows = rows.slice(1).filter((row) => row[0] === "sector-cooccurrence");
  assert.equal(comparisonRows.length, crosswalks.comparisons.length);
  assert.equal(overlapRows.length, crosswalks.sectorCooccurrence.length);
});

test("rebuild matches the committed files", async () => {
  const root = process.env.PRESENCIS_CORPUS_ROOT;
  assert.ok(root, "PRESENCIS_CORPUS_ROOT is required");
  const outDir = mkdtempSync(join(tmpdir(), "crosswalks-"));
  try {
    const stats = await buildCrosswalks({ corpusRoot: root, outDir });
    assert.equal(stats.frameworks, 95);
    assert.equal(stats.sectors, 11);
    for (const name of ["frameworks.json", "sectors.json", "crosswalks.json", "crosswalks.csv"]) {
      assert.equal(readFileSync(join(outDir, name), "utf8"), readFileSync(join(DATA, name), "utf8"), name);
    }
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("public tree has zero IP-audit findings", () => {
  const script = findAuditScript(ROOT);
  assert.ok(script, "IP audit script not found; scanned nothing");
  const run = spawnSync(process.execPath, [script, ROOT], { encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ok 0 findings/);
});
