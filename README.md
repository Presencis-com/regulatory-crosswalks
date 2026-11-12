# Regulatory crosswalks

Public, read-only metadata for the active English regulations published at [presencis.com](https://presencis.com).

The package emits:

- `data/frameworks.json` — one object per active framework, with issuer, official text URL, Wikidata QID when one is known, sectors, and a canonical `https://presencis.com/regulations/<id>/` URL
- `data/sectors.json` — sector maps limited to those active frameworks
- `data/crosswalks.json` and `data/crosswalks.csv` — comparison pairs whose both sides are active, plus the sector co-occurrence pairs

Retired framework ids that begin with `ru-` are refused. A malformed id is refused. The build writes nothing if either check fails.

## Rebuild

Set `PRESENCIS_CORPUS_ROOT` to a checkout that contains `apps/web/scripts/locale-registry.json`, `apps/web/scripts/sector-mapping.json`, `apps/web/scripts/regulation-authorities.js`, `apps/web/scripts/regulation-wikidata.js`, and `apps/web/content`.

```bash
export PRESENCIS_CORPUS_ROOT=/path/to/corpus
node scripts/build-crosswalks.mjs
node --test
```

Node.js 22 or newer. No network calls. Apache-2.0.
