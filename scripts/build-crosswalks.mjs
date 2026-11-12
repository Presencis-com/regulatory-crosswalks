/**
 * Build public framework, sector, and crosswalk files from a local corpus checkout.
 *
 * PRESENCIS_CORPUS_ROOT must point at the checkout that contains
 * apps/web/scripts/locale-registry.json and apps/web/content.
 * The script reads that tree and writes data/ under this package.
 * It refuses retired ru-* framework ids and does not write partial output.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RETIRED_IDS = Object.freeze([
  "ru-149fz",
  "ru-152fz",
  "ru-242fz",
  "ru-ai-framework",
  "ru-gost-crypto",
  "ru-rkn",
]);
const RETIRED_COMPARISON = "gdpr-vs-ru-152fz";
const EXPECTED_FRAMEWORKS = 95;
const EXPECTED_SECTORS = 11;

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const QID_RE = /^Q[1-9][0-9]*$/;
const HTTPS_RE = /^https:\/\/[^\s]+$/;

export function assertActiveFrameworkId(id) {
  if (typeof id !== "string" || !ID_RE.test(id)) {
    throw new Error(`malformed framework id: ${JSON.stringify(id)}`);
  }
  if (id.startsWith("ru-") || RETIRED_IDS.includes(id)) {
    throw new Error(`retired framework id: ${id}`);
  }
  return id;
}

function fail(message) {
  const error = new Error(message);
  error.code = "CROSSWALK_BUILD";
  throw error;
}

function readJson(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    fail(`unreadable JSON ${path}: ${err.message}`);
  }
  return parsed;
}

function corpusRoot() {
  const root = process.env.PRESENCIS_CORPUS_ROOT;
  if (!root || !root.trim()) {
    fail("PRESENCIS_CORPUS_ROOT is unset; refusing to guess a corpus checkout");
  }
  return root;
}

function parseFrontmatter(text, filePath) {
  if (!text.startsWith("---\n")) fail(`missing frontmatter: ${filePath}`);
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) fail(`unclosed frontmatter: ${filePath}`);
  const raw = text.slice(4, end);
  const fields = {};
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const cut = line.indexOf(":");
    if (cut <= 0) fail(`frontmatter line has no key: ${filePath}`);
    const key = line.slice(0, cut).trim();
    const value = line.slice(cut + 1).trim();
    let decoded;
    try {
      decoded = JSON.parse(value);
    } catch (err) {
      fail(`frontmatter value is not a JSON string (${key}) in ${filePath}: ${err.message}`);
    }
    if (typeof decoded !== "string") fail(`frontmatter ${key} is not a string in ${filePath}`);
    fields[key] = decoded;
  }
  return fields;
}

function csvField(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function httpsOrNull(value, label) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !HTTPS_RE.test(value)) {
    fail(`${label} is not an https URL: ${JSON.stringify(value)}`);
  }
  return value;
}

export async function buildCrosswalks(options = {}) {
  const root = options.corpusRoot || corpusRoot();
  const outDir = options.outDir;
  if (!outDir) fail("outDir is required");

  const scripts = join(root, "apps/web/scripts");
  const content = join(root, "apps/web/content");
  const registry = readJson(join(scripts, "locale-registry.json"));
  const sectorFile = readJson(join(scripts, "sector-mapping.json"));
  const authoritiesMod = await import(join(scripts, "regulation-authorities.js"));
  const wikidataMod = await import(join(scripts, "regulation-wikidata.js"));
  const authorities = authoritiesMod.REGULATORY_AUTHORITIES;
  const qids = wikidataMod.WIKIDATA_QIDS;
  if (!authorities || typeof authorities !== "object") fail("REGULATORY_AUTHORITIES missing");
  if (!qids || typeof qids !== "object") fail("WIKIDATA_QIDS missing");

  const regulationIds = registry.regulations;
  if (!Array.isArray(regulationIds)) fail("locale-registry.json regulations is not an array");
  if (regulationIds.length !== EXPECTED_FRAMEWORKS) {
    fail(`expected ${EXPECTED_FRAMEWORKS} registry regulations, found ${regulationIds.length}`);
  }
  const active = [];
  const seen = new Set();
  for (const id of regulationIds) {
    assertActiveFrameworkId(id);
    if (seen.has(id)) fail(`duplicate framework id: ${id}`);
    seen.add(id);
    active.push(id);
  }

  const sectorBlock = sectorFile.sectors;
  if (!sectorBlock || typeof sectorBlock !== "object" || Array.isArray(sectorBlock)) {
    fail("sector-mapping.json has no sectors object");
  }
  const sectorIds = Object.keys(sectorBlock);
  if (sectorIds.length !== EXPECTED_SECTORS) {
    fail(`expected ${EXPECTED_SECTORS} sectors, found ${sectorIds.length}`);
  }

  const sectors = [];
  const sectorByFramework = new Map(active.map((id) => [id, []]));
  for (const sectorId of sectorIds) {
    if (!ID_RE.test(sectorId)) fail(`malformed sector id: ${sectorId}`);
    const entry = sectorBlock[sectorId];
    if (!entry || typeof entry.label !== "string" || typeof entry.description !== "string") {
      fail(`sector ${sectorId} is missing label or description`);
    }
    if (!Array.isArray(entry.regulations)) fail(`sector ${sectorId} regulations is not an array`);
    const kept = [];
    for (const id of entry.regulations) {
      if (typeof id !== "string") fail(`sector ${sectorId} contains a non-string id`);
      if (id.startsWith("ru-") || RETIRED_IDS.includes(id)) {
        fail(`sector ${sectorId} lists retired id ${id}`);
      }
      if (!seen.has(id)) continue;
      if (kept.includes(id)) fail(`sector ${sectorId} lists ${id} twice`);
      kept.push(id);
      sectorByFramework.get(id).push(sectorId);
    }
    sectors.push({
      id: sectorId,
      label: entry.label,
      description: entry.description,
      regulations: kept,
    });
  }

  const frameworks = [];
  for (const id of active) {
    const metaPath = join(content, "regulations", id, "_meta.json");
    const meta = readJson(metaPath);
    if (meta.id !== id) fail(`meta id ${JSON.stringify(meta.id)} does not match directory ${id}`);
    for (const key of ["name", "officialName", "shortName", "jurisdiction", "status"]) {
      if (typeof meta[key] !== "string" || meta[key].trim() === "") {
        fail(`${id} meta field ${key} is empty`);
      }
    }
    // One active record (cis-controls-v8) publishes no effective date. Keep null.
    // Do not invent one.
    let effectiveDate = null;
    if (meta.effectiveDate != null) {
      if (typeof meta.effectiveDate !== "string" || meta.effectiveDate.trim() === "") {
        fail(`${id} effectiveDate is not a date string`);
      }
      effectiveDate = meta.effectiveDate;
    }
    let authorityName = null;
    let officialText = null;
    const authority = authorities[id];
    if (authority) {
      if (typeof authority.name !== "string" || authority.name.trim() === "") {
        fail(`${id} authority name is empty`);
      }
      authorityName = authority.name;
      officialText = httpsOrNull(authority.officialText, `${id} officialText`);
    } else if (meta.enforcementAuthority && typeof meta.enforcementAuthority === "object") {
      if (typeof meta.enforcementAuthority.name !== "string" || !meta.enforcementAuthority.name.trim()) {
        fail(`${id} enforcementAuthority.name is empty`);
      }
      authorityName = meta.enforcementAuthority.name;
      officialText = httpsOrNull(meta.enforcementAuthority.website, `${id} enforcementAuthority.website`);
    }
    let wikidataQid = null;
    if (Object.prototype.hasOwnProperty.call(qids, id) && qids[id] != null) {
      if (typeof qids[id] !== "string" || !QID_RE.test(qids[id])) {
        fail(`${id} wikidata qid is not a QID: ${JSON.stringify(qids[id])}`);
      }
      wikidataQid = qids[id];
    }
    const canonicalUrl = `https://presencis.com/regulations/${id}/`;
    frameworks.push({
      id,
      name: meta.name,
      officialName: meta.officialName,
      shortName: meta.shortName,
      jurisdiction: meta.jurisdiction,
      status: meta.status,
      effectiveDate,
      authority: authorityName,
      officialText,
      wikidataQid,
      sectors: sectorByFramework.get(id),
      canonicalUrl,
    });
  }

  const comparisons = [];
  const comparisonDir = join(content, "comparisons/en");
  const comparisonFiles = readdirSync(comparisonDir).filter((name) => name.endsWith(".md") && !name.startsWith("_"));
  comparisonFiles.sort();
  for (const name of comparisonFiles) {
    if (name.includes("ru-") || name.replace(/\.md$/, "") === RETIRED_COMPARISON) continue;
    const filePath = join(comparisonDir, name);
    const fields = parseFrontmatter(readFileSync(filePath, "utf8").replaceAll("\r\n", "\n").replaceAll("\r", "\n"), filePath);
    if (!fields.regulation_a || !fields.regulation_b) continue;
    let sourceId;
    let targetId;
    try {
      sourceId = assertActiveFrameworkId(fields.regulation_a);
      targetId = assertActiveFrameworkId(fields.regulation_b);
    } catch (err) {
      if (String(err.message).startsWith("retired framework id:")) throw err;
      continue;
    }
    if (!seen.has(sourceId) || !seen.has(targetId)) continue;
    const id = fields.comparison || name.replace(/\.md$/, "");
    if (!ID_RE.test(id)) fail(`malformed comparison id: ${id}`);
    if (id === RETIRED_COMPARISON || id.includes("ru-")) {
      fail(`retired comparison id reached emit: ${id}`);
    }
    if (typeof fields.title !== "string" || typeof fields.summary !== "string") {
      fail(`comparison ${id} is missing title or summary`);
    }
    comparisons.push({
      id,
      sourceId,
      targetId,
      title: fields.title,
      summary: fields.summary,
      canonicalUrl: `https://presencis.com/comparisons/${id}/`,
    });
  }
  comparisons.sort((a, b) => a.id.localeCompare(b.id));

  const pairSectors = new Map();
  for (const sector of sectors) {
    const ids = sector.regulations;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const left = ids[i] < ids[j] ? ids[i] : ids[j];
        const right = ids[i] < ids[j] ? ids[j] : ids[i];
        const key = `${left}\t${right}`;
        if (!pairSectors.has(key)) pairSectors.set(key, []);
        pairSectors.get(key).push(sector.id);
      }
    }
  }
  const sectorCooccurrence = [...pairSectors.entries()]
    .map(([key, shared]) => {
      const [sourceId, targetId] = key.split("\t");
      return { sourceId, targetId, sectors: shared };
    })
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.targetId.localeCompare(b.targetId));

  const payload = { comparisons, sectorCooccurrence };
  const serialized = {
    frameworks: `${JSON.stringify(frameworks, null, 2)}\n`,
    sectors: `${JSON.stringify(sectors, null, 2)}\n`,
    crosswalks: `${JSON.stringify(payload, null, 2)}\n`,
  };
  const blob = Object.values(serialized).join("\n");
  for (const retired of [...RETIRED_IDS, RETIRED_COMPARISON]) {
    if (blob.includes(retired)) fail(`refusing to write output that contains ${retired}`);
  }

  const header = ["kind", "source_id", "target_id", "title", "summary", "sectors", "canonical_url"];
  const rows = [header.map(csvField).join(",")];
  for (const item of comparisons) {
    rows.push(
      ["comparison", item.sourceId, item.targetId, item.title, item.summary, "", item.canonicalUrl]
        .map(csvField)
        .join(","),
    );
  }
  for (const item of sectorCooccurrence) {
    rows.push(
      ["sector-cooccurrence", item.sourceId, item.targetId, "", "", item.sectors.join("|"), ""]
        .map(csvField)
        .join(","),
    );
  }
  const csv = `${rows.join("\n")}\n`;
  if (csv.includes(RETIRED_COMPARISON) || RETIRED_IDS.some((id) => csv.includes(id))) {
    fail("refusing to write CSV that contains a retired id");
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "frameworks.json"), serialized.frameworks);
  writeFileSync(join(outDir, "sectors.json"), serialized.sectors);
  writeFileSync(join(outDir, "crosswalks.json"), serialized.crosswalks);
  writeFileSync(join(outDir, "crosswalks.csv"), csv);
  return {
    frameworks: frameworks.length,
    sectors: sectors.length,
    comparisons: comparisons.length,
    sectorCooccurrence: sectorCooccurrence.length,
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, "..", "data");
  buildCrosswalks({ outDir })
    .then((stats) => {
      process.stdout.write(
        `frameworks ${stats.frameworks} sectors ${stats.sectors} comparisons ${stats.comparisons} cooccurrence ${stats.sectorCooccurrence}\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(`build-crosswalks: ${err.message}\n`);
      process.exit(1);
    });
}
