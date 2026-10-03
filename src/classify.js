/*
 * Copyright 2026 Baden Hughes
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require("fs");
const path = require("path");

/**
 * Admin vs structural classification.
 *
 * A diff hunk is classified as **admin** when the *template* side consists
 * entirely of placeholder-shaped values that are clearly meant to be filled
 * in by the deployer (emails like <foo>@example.com, "UPDATE" marker
 * comments, generic example.com addresses). These values do NOT belong in
 * a replacements file; they belong in replacements-config.yaml globals or
 * environment-driven scripts.
 *
 * A diff that swaps one concrete value for another concrete value (e.g.
 * HomeRegion us-east-1 -> us-gov-west-1 for the GovCloud partition) is
 * structural, even if it lives inside replacements-config.yaml.
 *
 * Pure-insert hunks are always structural; we auto-anchor them against
 * preceding template context so the replacer can find the insertion point.
 */

// Markers that identify a template value as a placeholder waiting for the
// deployer to fill in a tenant-specific value. Deliberately narrow:
//   - angle-bracket wrappers used for named placeholders: <budget-notifications>, <perimeter-email>
//   - example.com domain used in all sample email addresses
//
// We do NOT match the bare word "UPDATE" because it appears in comments on
// legitimate structural values (e.g. "us-east-1 # <----- UPDATE TO YOUR HOME REGION"),
// which real partition replacements files (GovCloud, EU-sov) treat as structural.
const PLACEHOLDER_PATTERNS = [
  /<[^<>\s][^<>]*>/,
  /\bexample\.com\b/i,
];

/**
 * Split a file's text into lines, discarding the single trailing empty
 * element that `split("\n")` produces on text ending with a newline. Without
 * this, files that differ only in trailing-newline presence would generate
 * a spurious one-element hunk, and files that match otherwise would still
 * compare line-arrays with mismatched tails.
 */
function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function lineLooksPlaceholder(line) {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(line));
}

/**
 * A hunk's *template* side qualifies as admin when every non-blank line
 * contains a placeholder marker. (Blank lines are ignored.)
 */
function templateLooksAdmin(templateLines) {
  const nonBlank = templateLines.filter((l) => l.trim().length > 0);
  if (nonBlank.length === 0) return false;
  return nonBlank.every(lineLooksPlaceholder);
}

/**
 * Longest-increasing-subsequence of positions. Returns the indices (into
 * the input array) that form a longest strictly-increasing subsequence by
 * value. O(n log n).
 */
function lis(arr) {
  const tails = []; // tails[len-1] = index in arr of smallest tail of a LIS of that length
  const prev = new Int32Array(arr.length).fill(-1);
  for (let i = 0; i < arr.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[tails[mid]] < arr[i]) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = i;
    prev[i] = lo > 0 ? tails[lo - 1] : -1;
  }
  const out = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { out.push(k); k = prev[k]; }
  return out.reverse();
}

/**
 * LCS line diff over slice a[aOff..aOff+n] vs b[bOff..bOff+m].
 * Returns hunks with absolute (unsliced) start indices.
 */
function lcsDiff(aLines, bLines, aOff, bOff) {
  const n = aLines.length, m = bLines.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) {
    return [{
      templateLines: [], configuredLines: bLines.slice(),
      startIdxTemplate: aOff, startIdxConfigured: bOff, type: "insert",
    }];
  }
  if (m === 0) {
    return [{
      templateLines: aLines.slice(), configuredLines: [],
      startIdxTemplate: aOff, startIdxConfigured: bOff, type: "delete",
    }];
  }

  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      if (aLines[i] === bLines[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const hunks = [];
  let i = 0, j = 0;
  let cur = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  const begin = () => {
    if (!cur) cur = {
      templateLines: [], configuredLines: [],
      startIdxTemplate: aOff + i, startIdxConfigured: bOff + j,
    };
  };

  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) { flush(); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { begin(); cur.templateLines.push(aLines[i]); i++; }
    else { begin(); cur.configuredLines.push(bLines[j]); j++; }
  }
  while (i < n) { begin(); cur.templateLines.push(aLines[i]); i++; }
  while (j < m) { begin(); cur.configuredLines.push(bLines[j]); j++; }
  flush();

  return hunks.map(h => ({
    ...h,
    type: h.templateLines.length && h.configuredLines.length ? "replace"
        : h.templateLines.length ? "delete" : "insert",
  }));
}

/**
 * Patience diff. Finds lines that appear exactly once in both files; takes
 * the longest increasing subsequence of those as anchor points; LCS between
 * anchors. Avoids the LCS pathology where identical short lines (tags trios,
 * blank lines, "- key: X" starters) match non-locally across unrelated
 * stanzas, producing tangled output.
 *
 * Falls back to plain LCS if there are no unique common lines.
 */
function patienceDiff(aLines, bLines) {
  // Count occurrences in each side.
  const aCount = new Map(), bCount = new Map();
  for (const l of aLines) aCount.set(l, (aCount.get(l) || 0) + 1);
  for (const l of bLines) bCount.set(l, (bCount.get(l) || 0) + 1);

  // Positions of lines unique on BOTH sides.
  const aPos = new Map(), bPos = new Map();
  for (let i = 0; i < aLines.length; i++) {
    const l = aLines[i];
    if (aCount.get(l) === 1 && bCount.get(l) === 1) aPos.set(l, i);
  }
  for (let i = 0; i < bLines.length; i++) {
    const l = bLines[i];
    if (aCount.get(l) === 1 && bCount.get(l) === 1) bPos.set(l, i);
  }

  // Pair up unique lines, sorted by position in A.
  const pairs = [];
  for (const [l, ai] of aPos) {
    const bi = bPos.get(l);
    if (bi !== undefined) pairs.push({ ai, bi });
  }
  pairs.sort((x, y) => x.ai - y.ai);

  // LIS over bi — this is the anchor sequence.
  const bis = pairs.map(p => p.bi);
  const anchorIdx = lis(bis);
  const anchors = anchorIdx.map(k => pairs[k]);

  if (anchors.length === 0) {
    return lcsDiff(aLines, bLines, 0, 0);
  }

  // Diff each inter-anchor segment, then skip the anchor itself (it matched).
  const hunks = [];
  let aStart = 0, bStart = 0;
  for (const anc of anchors) {
    if (anc.ai > aStart || anc.bi > bStart) {
      const sub = lcsDiff(
        aLines.slice(aStart, anc.ai),
        bLines.slice(bStart, anc.bi),
        aStart, bStart
      );
      hunks.push(...sub);
    }
    aStart = anc.ai + 1;
    bStart = anc.bi + 1;
  }
  if (aStart < aLines.length || bStart < bLines.length) {
    const sub = lcsDiff(
      aLines.slice(aStart),
      bLines.slice(bStart),
      aStart, bStart
    );
    hunks.push(...sub);
  }
  return hunks;
}

/**
 * Align hunk boundaries with surrounding blank lines so the replacer
 * reproduces blank-line counts correctly.
 *
 * A pure delete whose pattern is `[content_lines_joined_by_newline]` (no
 * leading or trailing newline) is preceded and followed by newline chars
 * in the surrounding text. After `replaceAll(pattern, '')`, those two
 * newlines sit next to each other, creating one extra blank line vs the
 * intended output.
 *
 * Fix:
 *   1. Symmetric expansion: while both template and configured have a
 *      blank line immediately before/after the hunk, pull it into the
 *      hunk. This grows the pattern to include its surrounding newlines
 *      and grows the replacement to carry the configured blanks through
 *      verbatim.
 *   2. Asymmetric trailing absorb: after symmetric expansion, if the
 *      template still has more trailing blanks than configured, pull the
 *      excess into templateLines only.
 */
function alignBlanks(hunks, aLines, bLines) {
  for (const h of hunks) {
    // Phase 1a: expand backward through matched blank context.
    while (
      h.startIdxTemplate > 0 && h.startIdxConfigured > 0 &&
      aLines[h.startIdxTemplate - 1] === "" &&
      bLines[h.startIdxConfigured - 1] === ""
    ) {
      h.templateLines.unshift("");
      h.configuredLines.unshift("");
      h.startIdxTemplate--;
      h.startIdxConfigured--;
    }
    // Phase 1b: expand forward through matched blank context.
    let eT = h.startIdxTemplate + h.templateLines.length;
    let eC = h.startIdxConfigured + h.configuredLines.length;
    while (
      eT < aLines.length && eC < bLines.length &&
      aLines[eT] === "" && bLines[eC] === ""
    ) {
      h.templateLines.push("");
      h.configuredLines.push("");
      eT++; eC++;
    }
    // Phase 2: template-only trailing blank absorption.
    let tBl = 0; while (eT + tBl < aLines.length && aLines[eT + tBl] === "") tBl++;
    let cBl = 0; while (eC + cBl < bLines.length && bLines[eC + cBl] === "") cBl++;
    const absorb = Math.max(0, tBl - cBl);
    for (let k = 0; k < absorb; k++) h.templateLines.push(aLines[eT + k]);
    // Recompute type after expansion.
    h.type = h.templateLines.length && h.configuredLines.length ? "replace"
          : h.templateLines.length ? "delete" : "insert";
  }
  return hunks;
}

/**
 * Public entry: patience diff + blank-line absorption.
 */
function diffLines(aLines, bLines) {
  const hunks = patienceDiff(aLines, bLines);
  return alignBlanks(hunks, aLines, bLines);
}

function stripCommonIndent(lines) {
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length === 0) return { stripped: lines, indent: "" };
  let indent = nonEmpty[0].match(/^(\s*)/)[1];
  for (const l of nonEmpty) {
    const li = l.match(/^(\s*)/)[1];
    let k = 0;
    while (k < indent.length && k < li.length && indent[k] === li[k]) k++;
    indent = indent.slice(0, k);
    if (!indent) break;
  }
  const stripped = lines.map(l => l.startsWith(indent) ? l.slice(indent.length) : l);
  return { stripped, indent };
}

const MAX_ANCHOR_EXPANSION = 30;

function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let count = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { count++; i += needle.length; }
  return count;
}

/**
 * Expand a hunk's pattern backward (prepending preceding template context
 * lines) until the pattern occurs exactly once in the full template text.
 * The replacer uses `result.replaceAll(pattern, replacement)`, so a
 * non-unique pattern silently floods the file. Insert hunks start with an
 * empty pattern and must build one from context; replace/delete hunks
 * extend their existing pattern.
 *
 * Pure-delete patterns additionally get a trailing '\n' appended: without
 * it, `replaceAll(block, '')` merges the newlines on either side of the
 * deleted block into one extra blank line in the output. Consuming the
 * trailing '\n' as part of the pattern prevents that.
 */
function hunkToItem(hunk, templateLines, templateText) {
  let start = hunk.startIdxTemplate;
  let patternLines = hunk.templateLines.slice();
  let replacementLines = hunk.configuredLines.slice();

  const buildPattern = () => {
    if (patternLines.length === 0) return "";
    const base = patternLines.join("\n");
    return hunk.type === "delete" ? base + "\n" : base;
  };

  const buildReplacement = () => {
    if (replacementLines.length === 0) return "";
    const base = replacementLines.join("\n");
    // When pattern ends with '\n' (delete type that got anchor-expanded
    // so replacement = preserved anchor), the replacement must also end
    // with '\n' or the next line's content gets concatenated onto the
    // last replacement line.
    return hunk.type === "delete" ? base + "\n" : base;
  };

  const isUnique = () => {
    const p = buildPattern();
    return !!p && countOccurrences(templateText, p) === 1;
  };

  for (let k = 0; k < MAX_ANCHOR_EXPANSION; k++) {
    if (isUnique()) break;
    if (start === 0) break;
    start--;
    patternLines.unshift(templateLines[start]);
    replacementLines.unshift(templateLines[start]);
  }

  const pattern = buildPattern();
  const replacement = buildReplacement();

  if (!pattern) {
    return {
      _warning: `insert at line ${hunk.startIdxTemplate} has no preceding anchor (start-of-file insert)`,
      pattern: "",
      replacement: hunk.configuredLines.join("\n"),
    };
  }

  const occ = countOccurrences(templateText, pattern);
  if (occ !== 1) {
    return {
      _warning: `pattern at template line ${hunk.startIdxTemplate} is not unique after ${MAX_ANCHOR_EXPANSION} expansions (${occ} occurrences). The replacer's replaceAll will substitute every match; review manually.`,
      pattern,
      replacement,
    };
  }

  return { pattern, replacement };
}

/**
 * Classify a single paired file into admin changes + structural items.
 */
function classifyPair(pair) {
  const result = {
    rel: pair.rel,
    status: pair.status,
    structuralItems: [],
    adminChangeLines: [],
    postActions: [],
    warnings: [],
  };

  if (pair.status === "template-only") {
    result.postActions.push({ type: "removeFile", files: [pair.rel] });
    return result;
  }
  if (pair.status === "configured-only") {
    result.warnings.push(
      `Configured dir adds a file not in template: ${pair.rel} (replacer cannot add files; add manually)`
    );
    return result;
  }

  const tText = fs.readFileSync(pair.templatePath, "utf8");
  const cText = fs.readFileSync(pair.configuredPath, "utf8");
  if (tText === cText) return result;

  const tLines = splitLines(tText);
  const cLines = splitLines(cText);
  const hunks = diffLines(tLines, cLines);

  // Track running text so each item's pattern is checked for uniqueness
  // against the state the replacer would see AFTER previous items apply.
  // Without this, a later delete-hunk's pattern may become ambiguous
  // because an earlier insert duplicated the block.
  let runningText = tText;

  for (const hunk of hunks) {
    // Admin = a tenant filling in a placeholder value (replace type).
    // Pure deletes of placeholder blocks (e.g. GovCloud dropping the entire
    // BudgetsEmail stanza) are partition-structural, not admin. Pure
    // inserts have no template side to inspect and are always structural.
    const isAdmin = hunk.type === "replace" && templateLooksAdmin(hunk.templateLines);

    if (isAdmin) {
      result.adminChangeLines.push({
        rel: pair.rel,
        from: hunk.templateLines.join("\n"),
        to: hunk.configuredLines.join("\n"),
      });
      continue;
    }

    const item = hunkToItem(hunk, tLines, runningText);
    if (item._warning) {
      result.warnings.push(`${pair.rel}: ${item._warning}`);
      delete item._warning;
    }
    result.structuralItems.push(item);

    // Simulate the replacer: update runningText so subsequent items see the
    // same intermediate state the replacer will.
    if (item.pattern && runningText.includes(item.pattern)) {
      runningText = runningText.split(item.pattern).join(item.replacement);
    }
  }

  return result;
}

function classifyAndDiff(pairs) {
  const fileEntries = [];
  const adminChanges = [];
  const warnings = [];
  const postActions = [];

  for (const pair of pairs) {
    const r = classifyPair(pair);
    adminChanges.push(...r.adminChangeLines);
    warnings.push(...r.warnings);
    postActions.push(...r.postActions);
    if (r.structuralItems.length > 0) {
      fileEntries.push({ filename: pair.rel, items: r.structuralItems });
    }
  }

  if (postActions.length > 0) {
    const merged = {};
    for (const a of postActions) {
      if (a.type === "removeFile") {
        merged.removeFile = merged.removeFile || [];
        merged.removeFile.push(...a.files);
      }
    }
    const postActionsBlock = [];
    if (merged.removeFile) {
      postActionsBlock.push({ type: "removeFile", files: merged.removeFile });
    }
    fileEntries.push({ _postActions: postActionsBlock });
  }

  return { fileEntries, adminChanges, warnings };
}

module.exports = {
  classifyAndDiff,
  classifyPair,
  diffLines,
  splitLines,
  stripCommonIndent,
  templateLooksAdmin,
  lineLooksPlaceholder,
  hunkToItem,
  countOccurrences,
};
