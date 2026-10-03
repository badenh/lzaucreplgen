const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { execFileSync } = require("child_process");
const { pairFiles, walk: configWalk } = require("./pairFiles");

/**
 * Apply the generated replacements to a fresh copy of the template, then
 * byte-compare the result against the configured dir.
 *
 * Validation steps for v1:
 *   1. Copy template -> workDir/applied
 *   2. Apply replacer in-process (reuses upstream config-replacer logic)
 *   3. Parse every YAML/JSON config to confirm structural validity
 *   4. Byte-compare each file against configured dir -> mismatch report
 */
async function roundTrip({ templateDir, configuredDir, replacementsFile, workDir, adminFiles, log }) {
  adminFiles = adminFiles || new Set();
  const appliedDir = path.join(workDir, "applied");
  if (fs.existsSync(appliedDir)) {
    fs.rmSync(appliedDir, { recursive: true, force: true });
  }
  copyDir(templateDir, appliedDir);

  const replacerPath = findUpstreamReplacer(workDir, templateDir);
  if (!replacerPath) {
    throw new Error(
      "Could not locate upstream scripts/config-replacer.js. Ensure the template was obtained via --ref (clone) or point --template at a dir that includes scripts/."
    );
  }

  const replacer = require(replacerPath);
  const replacements = yaml.load(fs.readFileSync(replacementsFile, "utf8")) || [];

  const applyErrors = [];
  for (const fileConfig of replacements) {
    if (fileConfig.postActions) {
      for (const action of fileConfig.postActions) {
        if (action.type === "removeFile") {
          for (const f of action.files) {
            const p = path.join(appliedDir, f);
            if (fs.existsSync(p)) fs.rmSync(p, { force: true });
          }
        } else if (action.type === "removeFolder") {
          for (const folder of action.folders) {
            const p = path.join(appliedDir, folder);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
          }
        }
      }
      continue;
    }
    try {
      const modified = replacer.processConfigFile(appliedDir, fileConfig);
      fs.writeFileSync(path.join(appliedDir, fileConfig.filename), modified, "utf8");
    } catch (err) {
      applyErrors.push(`${fileConfig.filename}: ${err.message}`);
    }
  }

  // Parse validation (scoped to config files via same walker that pairFiles uses)
  const parseErrors = [];
  for (const rel of configWalk(appliedDir)) {
    const ext = path.extname(rel);
    const full = path.join(appliedDir, rel);
    const text = fs.readFileSync(full, "utf8");
    // Skip files that use LZA template interpolation (${VAR} or {{ Var }}):
    // these are not expected to be strict JSON/YAML pre-render.
    if (ext === ".json" && /\$\{[^}]+\}/.test(text)) continue;
    try {
      if (ext === ".json") JSON.parse(text);
      else yaml.load(text);
    } catch (err) {
      parseErrors.push(`${rel}: ${err.message.split("\n")[0]}`);
    }
  }

  // Byte compare. Split into "unexpected" (true failures) and "admin-expected"
  // (files whose only diffs were classified as admin — not reproducible via
  // the replacements file, by design).
  const pairs = pairFiles(appliedDir, configuredDir);
  const mismatches = [];
  const adminExpected = [];
  for (const p of pairs) {
    if (p.status !== "both") {
      mismatches.push({ rel: p.rel, reason: p.status });
      continue;
    }
    const a = fs.readFileSync(p.templatePath);
    const b = fs.readFileSync(p.configuredPath);
    if (!a.equals(b)) {
      const bucket = adminFiles.has(p.rel) ? adminExpected : mismatches;
      bucket.push({ rel: p.rel, reason: "bytes-differ" });
    }
  }

  const reportPath = path.join(workDir, "roundtrip-report.md");
  writeReport(reportPath, { applyErrors, parseErrors, mismatches, adminExpected });
  log(`      Report:    ${reportPath}`);

  return {
    ok: applyErrors.length === 0 && parseErrors.length === 0 && mismatches.length === 0,
    appliedDir,
    reportPath,
    applyErrors,
    parseErrors,
    mismatches: mismatches.length,
    adminExpected: adminExpected.length,
  };
}

function writeReport(outPath, { applyErrors, parseErrors, mismatches, adminExpected }) {
  const lines = ["# Round-trip report", ""];
  lines.push(`- apply errors: ${applyErrors.length}`);
  lines.push(`- parse errors: ${parseErrors.length}`);
  lines.push(`- byte mismatches (unexpected): ${mismatches.length}`);
  lines.push(`- byte mismatches (admin-expected): ${adminExpected.length}`);
  lines.push("");
  if (applyErrors.length) {
    lines.push("## Apply errors");
    for (const e of applyErrors) lines.push(`- ${e}`);
    lines.push("");
  }
  if (parseErrors.length) {
    lines.push("## Parse errors");
    for (const e of parseErrors) lines.push(`- ${e}`);
    lines.push("");
  }
  if (mismatches.length) {
    lines.push("## Unexpected byte mismatches");
    for (const m of mismatches) lines.push(`- ${m.rel} (${m.reason})`);
    lines.push("");
  }
  if (adminExpected && adminExpected.length) {
    lines.push("## Admin-expected mismatches");
    lines.push("");
    lines.push("These files differ because they contain admin values captured in the");
    lines.push("admin report, not in the replacements file. This is by design.");
    lines.push("");
    for (const m of adminExpected) lines.push(`- ${m.rel}`);
    lines.push("");
  }
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

function findUpstreamReplacer(workDir, templateDir) {
  // The merged template dir does NOT contain scripts/. Look in the clone
  // (sibling of merged in workDir) and in a repo-local upstream/ dir.
  const candidates = [];
  const entries = fs.existsSync(workDir) ? fs.readdirSync(workDir) : [];
  for (const name of entries) {
    if (name.startsWith("clone-")) {
      candidates.push(path.join(workDir, name, "scripts", "config-replacer.js"));
    }
  }
  candidates.push(path.join(templateDir, "scripts", "config-replacer.js"));
  candidates.push(path.join(workDir, "..", "upstream", "scripts", "config-replacer.js"));
  candidates.push(path.resolve(__dirname, "..", "upstream", "scripts", "config-replacer.js"));
  for (const c of candidates) {
    if (fs.existsSync(c)) return path.resolve(c);
  }
  return null;
}

module.exports = { roundTrip };
