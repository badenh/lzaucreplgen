const path = require("path");
const fs = require("fs");

const { resolveTemplate } = require("./resolveTemplate");
const { pairFiles } = require("./pairFiles");
const { classifyAndDiff } = require("./classify");
const { emitReplacements, emitAdminReport } = require("./emit");
const { roundTrip } = require("./roundtrip");

const UPSTREAM_REPO = "https://github.com/aws/lza-universal-configuration.git";

function mergeSplitLayout(srcDir, network, dstDir, log) {
  const baseSrc = path.join(srcDir, "modules", "base", "default");
  const netSrc = path.join(srcDir, "modules", "network", network);
  if (!fs.existsSync(baseSrc) || !fs.existsSync(netSrc)) {
    throw new Error(
      `--split-layout: expected ${baseSrc} and ${netSrc} to both exist in configured dir.`
    );
  }
  log(`      Merging configured base/default + network/${network} -> ${dstDir}`);
  fs.mkdirSync(dstDir, { recursive: true });
  const copy = (s, d) => {
    for (const entry of fs.readdirSync(s, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const sp = path.join(s, entry.name), dp = path.join(d, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(dp, { recursive: true }); copy(sp, dp); }
      else if (entry.isFile()) fs.copyFileSync(sp, dp);
    }
  };
  copy(baseSrc, dstDir);
  copy(netSrc, dstDir);
}

async function run(opts) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);

  fs.mkdirSync(opts.workDir, { recursive: true });

  log(`[1/5] Resolving template...`);
  const templateDir = await resolveTemplate({
    ref: opts.ref,
    localTemplate: opts.templateDir,
    network: opts.network,
    splitLayout: opts.splitLayout,
    workDir: opts.workDir,
    repoUrl: UPSTREAM_REPO,
    log,
  });

  let configuredDir = opts.configuredDir;
  if (opts.splitLayout) {
    if (!opts.network) {
      throw new Error("--split-layout requires --network to pick the overlay to merge.");
    }
    const dst = path.join(opts.workDir, "configured-merged");
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    mergeSplitLayout(opts.configuredDir, opts.network, dst, log);
    configuredDir = dst;
  }

  log(`[2/5] Pairing files between template and configured dir...`);
  const pairs = pairFiles(templateDir, configuredDir);
  log(`      ${pairs.length} file(s) to compare.`);

  log(`[3/5] Classifying and diffing...`);
  const { fileEntries, adminChanges, warnings } = classifyAndDiff(pairs);

  log(`[4/5] Writing outputs...`);
  emitReplacements(opts.outFile, fileEntries, { quoteLines: opts.quoteLines });
  emitAdminReport(opts.adminReport, adminChanges, warnings);

  let roundtripResult = null;
  if (opts.roundtrip) {
    log(`[5/5] Round-trip (apply replacer + byte-compare)...`);
    const adminFiles = new Set(adminChanges.map(c => c.rel));
    roundtripResult = await roundTrip({
      templateDir,
      configuredDir,
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
