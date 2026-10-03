# lzaucreplgen

Generate a replacements file for the AWS Landing Zone Accelerator Universal Configuration (LZA UC) by diffing a configured instance against the upstream template. The output is validated by applying it back to the template and comparing byte-for-byte with your configured instance.

## Links

- Upstream LZA UC template: https://github.com/aws/lza-universal-configuration
- Sample replacements files: https://github.com/aws/lza-universal-configuration/tree/main/replacements
- The replacer that applies them: [`scripts/config-replacer.js`](https://github.com/aws/lza-universal-configuration/blob/main/scripts/config-replacer.js)
- The script that bundles base + network + replacements into a release zip: [`scripts/release-package.js`](https://github.com/aws/lza-universal-configuration/blob/main/scripts/release-package.js)
- Landing Zone Accelerator on AWS (the solution LZA UC configures): https://docs.aws.amazon.com/solutions/latest/landing-zone-accelerator-on-aws/

## Background

LZA UC is a template. Users customise it for their environments. Two kinds of changes are common.

1. **Admin changes** — emails, account IDs, home region, ASNs, CIDR blocks. In upstream LZA UC, these go into `replacements-config.yaml` as `globalReplacements` entries, or they are injected at build time by env-driven scripts. They do **not** go into a replacements YAML.
2. **Structural changes** — toggling services, adding or removing resources, changing deployment targets. These are what the files in `replacements/` encode, using `pattern`/`replacement` and `deleteBlock` entries.

`lzaucreplgen` reads your configured instance, compares it to the upstream template at a given ref, splits the differences into these two categories, writes a replacements file for the structural changes, and writes a report of the admin changes. It then applies the generated file back to a clean copy of the template and compares byte-for-byte with your configured instance.

## Requirements

- Node.js 18 or newer
- `git` on `PATH`

## Install

```bash
git clone https://github.com/badenh/lzaucreplgen.git
cd lzaucreplgen
npm install
npm link           # optional: puts the `lzaucreplgen` command on PATH
```

## Usage

```bash
lzaucreplgen <configured-dir> --ref <template-ref> --network <type> [options]
```

### Required

| Argument | Description |
|---|---|
| `<configured-dir>` | Your configured LZA UC directory, in merged shape (base + network overlay as produced by `release-package.js`). |
| `--ref <template-ref>` | Git tag, branch, or SHA of `aws/lza-universal-configuration` your configured dir was derived from. |
| `--network <type>` | `hub-and-spoke` or `shared-vpc`. Tells the tool which network overlay to merge from the template. |

### Options

| Flag | Default | Description |
|---|---|---|
| `--template <dir>` | — | Use a local template dir instead of cloning. With `--split-layout`, the template dir is merged the same way as the configured dir. |
| `--split-layout` | off | Treat `<configured-dir>` (and `--template`, if given) as upstream source shape: `modules/base/default` + `modules/network/<network>`. The tool merges both before diffing. Use this if you keep your configured LZA UC in the same split layout as upstream rather than the deployed merged shape. |
| `--quote-lines` | off | Wrap each `pattern`/`replacement` line in matching quotes inside the YAML block scalar. Matches the style used in the AWS GovCloud and EU-sovereign reference files. The replacer strips the wrapping quotes line-by-line at apply time, so semantics are preserved. |
| `--out <file>` | `replacements-generated.yaml` | Output replacements file. |
| `--admin-report <file>` | `admin-changes.md` | Admin-change report. |
| `--work <dir>` | `.tmp/lzaucreplgen` | Scratch dir for the template clone, merged copy, and round-trip output. |
| `--no-roundtrip` | off | Skip the apply + byte-compare step. |
| `-q`, `--quiet` | off | Suppress status output. |

### Example

```bash
lzaucreplgen ./my-lza-config \
  --ref v1.2.0 \
  --network hub-and-spoke \
  --out my-replacements.yaml \
  --admin-report my-admin-changes.md
```

The tool clones upstream at `v1.2.0`, merges `modules/base/default/` and `modules/network/hub-and-spoke/` into a scratch directory, and diffs that against `./my-lza-config`.

Outputs:

- `my-replacements.yaml` — the replacements file. Apply with `node upstream/scripts/config-replacer.js -w <template> my-replacements.yaml`.
- `my-admin-changes.md` — admin values to port into `replacements-config.yaml` or env-driven scripts.
- `.tmp/lzaucreplgen/roundtrip-report.md` — mismatch report from applying the file back to the template.

## Walkthrough

A worked example. The scenario: you forked LZA UC at `v1.2.0`, deployed it, and over time made three kinds of changes to your copy.

- Set `BudgetsEmail` from the template placeholder `<budget-notifications>@example.com` to `alerts@mycorp.io`.
- Disabled Macie by flipping `enable: true` to `enable: false` under the Macie block in `security-config.yaml`.
- Removed `service-control-policies/lza-deployment-guardrails-1.json` and `-2.json` because you deploy via a different pipeline.

You now want a replacements file that reproduces the structural parts of these changes against the upstream template.

### 1. Lay out inputs

Your configured dir is in merged shape (base + network overlay copied flat), as produced by `release-package.js`.

```
./my-lza-config/
  accounts-config.yaml
  global-config.yaml
  security-config.yaml          # Macie disabled
  replacements-config.yaml      # BudgetsEmail set
  network-config.yaml
  service-control-policies/     # two JSON files removed
  ...
```

### 2. Run the tool

```bash
lzaucreplgen ./my-lza-config \
  --ref v1.2.0 \
  --network hub-and-spoke \
  --out my-replacements.yaml \
  --admin-report my-admin-changes.md
```

Expected output:

```
[1/5] Resolving template...
      Cloning https://github.com/aws/lza-universal-configuration.git @ v1.2.0 -> .tmp/lzaucreplgen/clone-v1.2.0
      Merging base + network/hub-and-spoke -> .tmp/lzaucreplgen/merged-v1.2.0-hub-and-spoke
[2/5] Pairing files between template and configured dir...
      34 file(s) to compare.
[3/5] Classifying and diffing...
[4/5] Writing outputs...
[5/5] Round-trip (apply replacer + byte-compare)...
      Report:    .tmp/lzaucreplgen/roundtrip-report.md
      Mismatches: 0

Replacements:   /abs/path/my-replacements.yaml
Admin report:   /abs/path/my-admin-changes.md
Round-trip:     OK (unexpected=0, admin-expected=1)
```

Exit code `0`. `admin-expected=1` is the `BudgetsEmail` change — expected (not a failure) because it is captured in the admin report rather than the replacements file.

### 3. Inspect `my-replacements.yaml`

```yaml
# Generated by lzaucreplgen. Review before use.
# Apply with upstream config-replacer.js.
- filename: security-config.yaml
  items:
    - pattern: '    enable: true # Enables Macie to all accounts in the organization'
      replacement: '    enable: false # Enables Macie to all accounts in the organization'
- postActions:
    - type: removeFile
      files:
        - service-control-policies/lza-deployment-guardrails-1.json
        - service-control-policies/lza-deployment-guardrails-2.json
```

Macie toggle is captured as a `pattern`/`replacement` item. The two file removals are captured as a `postActions.removeFile` entry.

### 4. Inspect `my-admin-changes.md`

```markdown
# Admin changes (not in replacements file)

## replacements-config.yaml

**template:**
    value: <budget-notifications>@example.com  <----- UPDATE EMAIL ADDRESS
**configured:**
    value: alerts@mycorp.io  <----- UPDATE EMAIL ADDRESS
```

Port this value into your deployment pipeline — either as a `globalReplacements` entry in `replacements-config.yaml`, or via an env-driven script equivalent to the upstream `scripts/index.js` pattern.

### 5. Inspect the round-trip report

```
.tmp/lzaucreplgen/roundtrip-report.md
```

```
# Round-trip report

- apply errors: 0
- parse errors: 0
- byte mismatches (unexpected): 0
- byte mismatches (admin-expected): 1

## Admin-expected mismatches

- replacements-config.yaml
```

The one `admin-expected` mismatch is `replacements-config.yaml` — different because of the admin value we deliberately kept out of the replacements file. All other 33 files are byte-identical between the applied template and your configured dir.

### 6. Apply the replacements file to a fresh template

To use the file in a new deployment, run the upstream replacer against a clean checkout.

```bash
git clone --branch v1.2.0 https://github.com/aws/lza-universal-configuration.git
cd lza-universal-configuration
# Build the merged input (base + hub-and-spoke)
mkdir -p /tmp/merged
cp -r modules/base/default/. /tmp/merged/
cp -r modules/network/hub-and-spoke/. /tmp/merged/
# Apply the replacements
node scripts/config-replacer.js -w /tmp/merged /path/to/my-replacements.yaml
```

`config-replacer.js` does not apply `postActions`. If your file has them, use `scripts/release-package.js` (which handles both) or remove the listed files manually.

### 7. Iterate

Common follow-ups.

- You get an `admin-expected` mismatch you did not expect. Check the admin report; if the heuristic misclassified a value, hand-edit `my-replacements.yaml` to include it as a `pattern`/`replacement` item.
- You get an `unexpected` byte mismatch. Diff the applied file against your configured file; often the fix is to re-run with a corrected `--ref` or to hand-adjust a specific item.
- You want to see the generated replacements written in AWS's quoted-line style (as in the GovCloud / EU-sov reference files). Re-run with `--quote-lines`.

## Round-trip validation

When `--no-roundtrip` is off (the default), the tool runs these steps.

1. Copy the resolved template to `.tmp/lzaucreplgen/applied/`.
2. Apply the generated replacements file using the upstream replacer's logic.
3. Parse every `.yaml`/`.json` output to catch any structural breakage introduced by the apply step.
4. Compare each applied file byte-for-byte against your configured dir and report mismatches.

A clean run reports:

```
apply errors: 0
parse errors: 0
byte mismatches (unexpected): 0
byte mismatches (admin-expected): 0
```

`admin-expected` mismatches are files that differ only because of admin values captured in the admin report (for example `replacements-config.yaml` with a user-specific email). These are expected and not a failure.

Unexpected mismatches usually mean one of three things.

- The configured dir has drifted from the ref you passed. Check out the exact ref the configured instance was derived from.
- The admin heuristic missed a value. Hand-edit the generated file.
- An insert hunk has no stable anchor. The tool emits a warning for this case; search the generated file for `_warning`-style notes.

## How admin and structural are decided

A diff hunk is classified as **admin** when every non-blank template line in the hunk carries a placeholder marker.

- Angle-bracket placeholder, e.g. `<budget-notifications>`, `<perimeter-email>`
- The `example.com` domain, used across all sample email addresses

Everything else is **structural** and goes into the replacements file. This includes partition swaps inside `replacements-config.yaml` such as changing HomeRegion from `us-east-1` to `us-gov-west-1`. The real GovCloud and EU-sovereign partition replacements files follow the same split.

Pure insert hunks (where the configured dir adds lines and the template had none) are always structural. The tool anchors them against preceding template lines until the anchor is unique in the template.

If the heuristic misclassifies, hand-edit the output or open an issue.

## How the diff works

The tool uses **patience diff**: lines that appear exactly once in both files are chosen as anchors, a longest-increasing-subsequence of those anchors defines the alignment, and LCS runs only within the inter-anchor segments. This avoids the common LCS failure mode where identical short lines (like `tags:` or blank lines) match non-locally across unrelated stanzas and produce tangled replacement items.

Pattern uniqueness is enforced against the simulated running state of the file after each previously generated item has been applied. This stops a later delete-hunk's pattern from becoming ambiguous after an earlier insert duplicated the block the delete targets.

Byte-perfect round-trip is confirmed against the two large AWS reference files:

- `replacements-for-aws-govcloud-us.yaml` (248 lines)
- `replacements-for-aws-european-sovereign-cloud.yaml` (357 lines)

## Limitations

- No deep LZA schema validation yet. The round-trip step only parses output files and byte-compares them.
- Moved blocks appear as delete + insert, not a single move hunk.
- A start-of-file insert has no preceding anchor; the tool emits a warning and the replacer cannot apply it unaided.
- `postActions.removeFile` is generated from diffs. `postActions.removeFolder` is honoured during round-trip apply but not generated.
- Upstream `config-replacer.js` ignores `postActions`. File and folder removals are applied by `release-package.js`. If you plan to apply with only `config-replacer.js`, run the removals separately.

## Development

```bash
node bin/lzaucreplgen.js --help
npm test
```

Layout:

```
bin/lzaucreplgen.js        CLI entry.
src/index.js               Orchestration.
src/resolveTemplate.js     Clone or merge the template.
src/pairFiles.js           Walk and pair config files.
src/classify.js            Admin heuristic, patience diff, hunk-to-item.
src/emit.js                YAML and admin-report writers.
src/roundtrip.js           Apply replacer, parse, byte compare.
test/classify.test.js      Unit tests.
```

## License

Apache-2.0.

Copyright 2026 Baden Hughes.
