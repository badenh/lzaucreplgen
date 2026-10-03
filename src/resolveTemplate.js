/*
 * Copyright 2026 Baden Hughes
 * SPDX-License-Identifier: Apache-2.0
 */

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

/**
 * Resolve an upstream template config directory to compare against.
 *
 * The upstream repo is a *source* layout (modules/base/default/, modules/network/<type>/).
 * The deployed config is a *merged* layout: base + chosen network overlay copied flat
 * into a single directory (see release-package.js). The user's configured dir reflects
 * that merged layout, so we must merge the template the same way before diffing.
 *
 * Resolution:
 *   --template <dir>   use as-is (assumed already merged)
 *   --ref <ref>        clone upstream + merge base/default + modules/network/<network>
 */
async function resolveTemplate({ ref, localTemplate, network, splitLayout, workDir, repoUrl, log }) {
  if (localTemplate) {
    if (!fs.existsSync(localTemplate)) {
      throw new Error(`--template dir does not exist: ${localTemplate}`);
    }
    if (splitLayout) {
      if (!network) {
        throw new Error("--split-layout with --template requires --network to merge the template.");
      }
      const baseSrc = path.join(localTemplate, "modules", "base", "default");
      const netSrc = path.join(localTemplate, "modules", "network", network);
      if (!fs.existsSync(baseSrc) || !fs.existsSync(netSrc)) {
        throw new Error(
          `--split-layout: expected ${baseSrc} and ${netSrc} to both exist in --template dir.`
        );
      }
      const dest = path.join(workDir, "template-merged-local");
      if (fs.existsSync(dest)) fs.rmSync(dest, { recursive: true, force: true });
      log(`      Merging local template base/default + network/${network} -> ${dest}`);
      fs.mkdirSync(dest, { recursive: true });
      copyDir(baseSrc, dest);
      copyDir(netSrc, dest);
      return dest;
    }
    log(`      Using local template: ${localTemplate}`);
    return localTemplate;
  }

  if (!ref) {
    throw new Error("Either --ref or --template must be provided.");
  }
  if (!network) {
    throw new Error(
      "--network <hub-and-spoke|shared-vpc> is required when using --ref (needed to merge the correct network overlay)."
    );
  }
  if (!["hub-and-spoke", "shared-vpc"].includes(network)) {
    throw new Error(`--network must be 'hub-and-spoke' or 'shared-vpc' (got '${network}').`);
  }

  const safeRef = ref.replace(/[^a-zA-Z0-9._-]/g, "_");
  const cloneDir = path.join(workDir, `clone-${safeRef}`);
  const mergedDir = path.join(workDir, `merged-${safeRef}-${network}`);

  if (!fs.existsSync(cloneDir)) {
    log(`      Cloning ${repoUrl} @ ${ref} -> ${cloneDir}`);
    execFileSync(
      "git",
      ["clone", "--depth", "1", "--branch", ref, repoUrl, cloneDir],
      { stdio: "inherit" }
    );
  } else {
    log(`      Reusing cached clone: ${cloneDir}`);
  }

  if (fs.existsSync(mergedDir)) {
    log(`      Reusing merged template: ${mergedDir}`);
    return mergedDir;
  }

  const baseSrc = path.join(cloneDir, "modules", "base", "default");
  const netSrc = path.join(cloneDir, "modules", "network", network);
  if (!fs.existsSync(baseSrc)) {
    throw new Error(`Template layout unexpected: ${baseSrc} not found.`);
  }
  if (!fs.existsSync(netSrc)) {
    throw new Error(`Template layout unexpected: ${netSrc} not found.`);
  }

  log(`      Merging base + network/${network} -> ${mergedDir}`);
  fs.mkdirSync(mergedDir, { recursive: true });
  copyDir(baseSrc, mergedDir);
  copyDir(netSrc, mergedDir);

  return mergedDir;
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

module.exports = { resolveTemplate };
