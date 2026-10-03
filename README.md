# lzaucreplgen

Generate a Landing Zone Accelerator Universal Configuration (LZA-UC) **replacements file**
from a configured instance by diffing it against the upstream template, with
round-trip validation.

> Status: **early scaffold (v0.1)**. Expect rough edges; feedback welcome.

## What it does

LZA-UC ships as a template that users customise for their environments. Two
kinds of changes typically happen:

1. **Administrative** — emails, account IDs, home region, ASNs, CIDR blocks.
   These belong in `replacements-config.yaml` (as `globalReplacements`) or in
   environment-driven scripts. They are **not** part of a replacements file.
2. **Structural** — toggling services, removing/adding resources, modifying
   deployment targets. These are what `replacements/replacements-for-*.yaml`
   files encode via `pattern`/`replacement` and `deleteBlock` entries.

`lzaucreplgen` compares your configured directory to the upstream template at
a known ref, classifies each diff as admin vs structural, emits a replacements
file for the structural changes, writes an admin-change report, and round-trips
the replacements file through the upstream replacer to confirm it reproduces
your configured instance byte-for-byte.

## Install

Requires Node.js 18+ and `git` on PATH.

```bash
git clone https://github.com/badenh/lzaucreplgen.git
cd lzaucreplgen
npm install
npm link           # optional: puts `lzaucreplgen` on PATH
```

## Usage

```bash
lzaucreplgen <configured-dir> --ref <template-ref> [options]
```

### Required

| Arg | Description |
|-----|-------------|
| `<configured-dir>` | Path to your configured LZA-UC **merged** config directory (base + chosen network overlay, i.e. the shape produced by `release-package.js` under `tempDir/config/`). |
| `--ref <template-ref>` | Git tag / branch / sha of the upstream `aws/lza-universal-configuration` that your configured dir was derived from. |
| `--network <type>` | `hub-and-spoke` or `shared-vpc` — tells the tool which network overlay to merge from the template. Required when using `--ref`. |

### Options

| Flag | Default | Description |
|------|---------|-------------|
| `--template <dir>` | *(none)* | Use an existing local **merged** template dir instead of cloning + merging. |
| `--out <file>` | `replacements-generated.yaml` | Output replacements file. |
| `--admin-report <file>` | `admin-changes.md` | Admin-change report. |
| `--work <dir>` | `.tmp/lzaucreplgen` | Working/scratch dir (template clone + round-trip output). |
| `--no-roundtrip` | *(off)* | Skip the apply + byte-compare validation step. |
| `-q`, `--quiet` | *(off)* | Suppress status output. |

### Example

```bash
lzaucreplgen ./my-lza-config \
  --ref v1.2.0 \
  --network hub-and-spoke \
  --out my-replacements.yaml \
  --admin-report my-admin-changes.md
```

The tool clones upstream at `v1.2.0`, merges `modules/base/default/` + `modules/network/hub-and-spoke/` into a scratch directory (same shape as `release-package.js` produces), and diffs that against `./my-lza-config`.

Outputs:

- `my-replacements.yaml` — apply with `node upstream/scripts/config-replacer.js -w <template> my-replacements.yaml`
- `my-admin-changes.md` — human-readable list of admin values to port into `replacements-config.yaml` or env.
- `.tmp/lzaucreplgen/roundtrip-report.md` — mismatch report from applying the file back onto the template.

## Round-trip validation

With `--no-roundtrip` **off** (default), the tool:

1. Copies the resolved template to `.tmp/lzaucreplgen/applied/`.
2. Loads and runs the upstream `scripts/config-replacer.js` logic against it,
   using the generated replacements file.
3. Parses every output `.yaml`/`.json` to catch structural breakage.
4. Byte-compares every file against your configured dir and reports mismatches.

A perfect run reports `apply errors: 0`, `parse errors: 0`, `byte mismatches: 0`.
Mismatches usually mean (a) the configured dir drifted from the ref, (b) there
are admin values the heuristic missed, or (c) the diff produced an unanchored
insert the replacer cannot apply.

## How admin-vs-structural is decided

A diff hunk is classified as **admin** when every non-blank template line
on the hunk contains at least one placeholder marker:

- Angle-bracket placeholder: `<budget-notifications>`, `<perimeter-email>`
- The `example.com` domain used in all sample email addresses

Everything else — including partition swaps inside `replacements-config.yaml`
such as HomeRegion `us-east-1` → `us-gov-west-1` — is structural and goes into
the replacements file. The real GovCloud and EU-sovereign partition
replacements files follow this same split.

Pure-insert hunks (configured dir adds lines where the template had none)
are always structural; the tool auto-anchors them against the three
preceding template lines so the replacer can locate the insertion point.

If the heuristic misclassifies, hand-edit the emitted files or open an issue.

## Limitations

- Deep LZA validation (full schema validator from the Accelerator repo) is
  not yet wired in. v1 does parse + byte-compare only.
- Line-based diff: moved blocks will appear as delete+insert.
- Start-of-file inserts have no preceding anchor and are emitted with a
  warning (the replacer cannot locate them without context).
- `postActions.removeFile` is emitted. `removeFolder` is honored during
  round-trip but not synthesized from diffs (we have no way to tell a
  deleted-folder from a bunch of deleted-files reliably).
- Upstream `config-replacer.js` **ignores** `postActions`; those are applied
  by `release-package.js`. If you plan to run only `config-replacer.js`
  against your template, you must apply the file removals separately.
- LCS line diff can match non-locally when a config contains many
  near-duplicate stanzas (e.g. repeated `name:/complianceResourceTypes:/tags:`
  blocks in `security-config.yaml`). The resulting replacements still apply
  but may duplicate output blocks. Mitigation: run the generated file
  through `config-replacer.js` and inspect the round-trip report; if byte
  mismatches appear, prune or merge the offending items manually.
- Delete hunks occasionally do not capture surrounding blank lines; the
  applied output may retain one or two spurious blank lines compared to
  the configured dir. Benign.

## Development

```bash
node bin/lzaucreplgen.js --help
```

Project layout:

```
bin/lzaucreplgen.js    CLI entry.
src/index.js           Orchestration.
src/resolveTemplate.js git clone / local template resolution.
src/pairFiles.js       File-pair walker.
src/classify.js        Admin heuristic + LCS line diff + replacer-item builder.
src/emit.js            Replacements YAML + admin-report writers.
src/roundtrip.js       Apply replacer + parse + byte compare.
```

## References

- Upstream template: <https://github.com/aws/lza-universal-configuration>
- Replacements examples: <https://github.com/aws/lza-universal-configuration/tree/main/replacements>
- Replacer script: <https://github.com/aws/lza-universal-configuration/blob/main/scripts/config-replacer.js>

## License

Apache-2.0.
