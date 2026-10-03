const path = require("path");
const fs = require("fs");

const { resolveTemplate } = require("./resolveTemplate");
const { pairFiles } = require("./pairFiles");
const { classifyAndDiff } = require("./classify");
const { emitReplacements, emitAdminReport } = require("./emit");
const { roundTrip } = require("./roundtrip");

const UPSTREAM_REPO = "https://github.com/aws/lza-universal-configuration.git";

async function run(opts) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  fs.mkdirSync(opts.workDir, { recursive: true });

  log(`[1/5] Resolving template...`);
  const templateDir = await resolveTemplate({
    ref: opts.ref,
    localTemplate: opts.templateDir,
    network: opts.network,
    workDir: opts.workDir,
    repoUrl: UPSTREAM_REPO,
    log,
  });

  log(`[2/5] Pairing files between template and configured dir...`);
  const pairs = pairFiles(templateDir, opts.configuredDir);
  log(`      ${pairs.length} file(s) to compare.`);

  log(`[3/5] Classifying and diffing...`);
  const { fileEntries, adminChanges, warnings } = classifyAndDiff(pairs);

  log(`[4/5] Writing outputs...`);
  emitReplacements(opts.outFile, fileEntries);
  emitAdminReport(opts.adminReport, adminChanges, warnings);

  let roundtripResult = null;
  if (opts.roundtrip) {
    log(`[5/5] Round-trip (apply replacer + byte-compare)...`);
    const adminFiles = new Set(adminChanges.map(c => c.rel));
    roundtripResult = await roundTrip({
      templateDir,
      configuredDir: opts.configuredDir,
      replacementsFile: opts.outFile,
      workDir: opts.workDir,
      adminFiles,
      log,
    });
    log(`      Mismatches: ${roundtripResult.mismatches}`);
  } else {
    log(`[5/5] Round-trip skipped (--no-roundtrip).`);
  }

  return { fileEntries, adminChanges, warnings, roundtrip: roundtripResult };
}

module.exports = { run };
