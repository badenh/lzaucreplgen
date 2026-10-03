/*
 * Copyright 2026 Baden Hughes
 * SPDX-License-Identifier: Apache-2.0
 */

const path = require("path");
const fs = require("fs");

const CONFIG_EXTS = new Set([".yaml", ".yml", ".json"]);
const SKIP_DIRS = new Set([".git", "node_modules", "docs", "scripts", "replacements"]);

function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(".")) continue;
        if (CONFIG_EXTS.has(path.extname(entry.name))) {
          out.push(path.relative(root, full));
        }
      }
    }
  }
  return out;
}

/**
 * Pair config files between template and configured dirs by relative path.
 *
 * Returns array of { rel, templatePath|null, configuredPath|null, status }
 *   status: "both" | "configured-only" | "template-only"
 */
function pairFiles(templateDir, configuredDir) {
  const tFiles = new Set(walk(templateDir));
  const cFiles = new Set(walk(configuredDir));

  const all = new Set([...tFiles, ...cFiles]);
  const out = [];
  for (const rel of [...all].sort()) {
    const inT = tFiles.has(rel);
    const inC = cFiles.has(rel);
    out.push({
      rel,
      templatePath: inT ? path.join(templateDir, rel) : null,
      configuredPath: inC ? path.join(configuredDir, rel) : null,
      status: inT && inC ? "both" : inT ? "template-only" : "configured-only",
    });
  }
  return out;
}

module.exports = { pairFiles, walk };
