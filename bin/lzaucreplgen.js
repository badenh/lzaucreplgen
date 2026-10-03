#!/usr/bin/env node
/**
 * lzaucreplgen CLI entry.
 *
 * Usage:
 *   lzaucreplgen <configured-dir> --ref <template-ref> [--template <dir>] \
 *                [--out replacements.yaml] [--admin-report admin-changes.md] \
 *                [--work <tmpdir>] [--no-roundtrip] [--quiet]
 */

const path = require("path");
const fs = require("fs");
const { run } = require("../src/index.js");

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      args.flags.help = true;
    } else if (a === "--quiet" || a === "-q") {
      args.flags.quiet = true;
    } else if (a === "--no-roundtrip") {
      args.flags.noRoundtrip = true;
    } else if (a === "--quote-lines") {
      args.flags.quoteLines = true;
    } else if (a === "--split-layout") {
      args.flags.splitLayout = true;
    } else if (a.startsWith("--")) {
      args.flags[a.slice(2)] = argv[++i];
    } else {
      args._.push(a);
    }
  }
  return args;
}

function showHelp() {
  console.log(`lzaucreplgen - Generate LZA-UC replacements file from a configured instance.

Usage:
  lzaucreplgen <configured-dir> --ref <template-ref> [options]

Required:
  <configured-dir>        Path to the user's configured LZA-UC *merged* config dir
                          (base + chosen network overlay, as produced at deploy time).
  --ref <template-ref>    Git tag/branch/sha of the upstream template this
                          configured dir was derived from.
  --network <type>        Network overlay to merge from the template:
                          hub-and-spoke | shared-vpc. Required when using --ref.

Options:
  --template <dir>        Use an existing local *merged* template dir instead of cloning.
  --out <file>            Replacements file to emit (default: replacements-generated.yaml).
  --admin-report <file>   Admin-change report path (default: admin-changes.md).
  --work <dir>            Working/scratch dir (default: .tmp/lzaucreplgen).
  --no-roundtrip          Skip replacer round-trip + byte-compare.
  --quote-lines           Wrap each pattern/replacement line in quotes
                          (matches the idiom in AWS GovCloud / EU-sov files).
  --split-layout          Treat <configured-dir> as upstream source layout
                          (modules/base/default + modules/network/<network>);
                          merge before diffing.
  -q, --quiet             Suppress status output.
  -h, --help              Show this help.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.help) {
    showHelp();
    process.exit(0);
  }
  if (args._.length < 1) {
    showHelp();
    process.exit(1);
  }

  const configuredDir = path.resolve(args._[0]);
  const ref = args.flags.ref;
  if (!ref && !args.flags.template) {
    console.error("Error: --ref <template-ref> is required (or pass --template <dir>).");
    process.exit(2);
  }

  if (!fs.existsSync(configuredDir)) {
    console.error(`Error: configured-dir does not exist: ${configuredDir}`);
    process.exit(2);
  }

  const opts = {
    configuredDir,
    ref,
    network: args.flags.network || null,
    templateDir: args.flags.template ? path.resolve(args.flags.template) : null,
    outFile: path.resolve(args.flags.out || "replacements-generated.yaml"),
    adminReport: path.resolve(args.flags["admin-report"] || "admin-changes.md"),
    workDir: path.resolve(args.flags.work || ".tmp/lzaucreplgen"),
    roundtrip: !args.flags.noRoundtrip,
    quoteLines: !!args.flags.quoteLines,
    splitLayout: !!args.flags.splitLayout,
    quiet: !!args.flags.quiet,
  };

  try {
    const result = await run(opts);
    if (!opts.quiet) {
      console.log(`\nReplacements:   ${opts.outFile}`);
      console.log(`Admin report:   ${opts.adminReport}`);
      if (result.roundtrip) {
        const rt = result.roundtrip;
        console.log(
          `Round-trip:     ${rt.ok ? "OK" : "FAIL"} (unexpected=${rt.mismatches}, admin-expected=${rt.adminExpected})`
        );
      }
    }
    process.exit(result.roundtrip && !result.roundtrip.ok ? 3 : 0);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}

main();
