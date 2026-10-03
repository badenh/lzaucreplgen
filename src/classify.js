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

const ANCHOR_CONTEXT_LINES = 3;

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
 * LCS-based line diff; returns an array of hunks keyed by position in the
 * template file. Each hunk is one of:
 *   - replace: templateLines non-empty + configuredLines non-empty
 *   - delete:  templateLines non-empty + configuredLines empty
 *   - insert:  templateLines empty + configuredLines non-empty
 */
function diffLines(aLines, bLines) {
  const n = aLines.length, m = bLines.length;
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
  const beginHunk = (startI) => {
    if (!cur) cur = { templateLines: [], configuredLines: [], startIdxTemplate: startI };
  };

  while (i < n && j < m) {
    if (aLines[i] === bLines[j]) {
      flush();
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      beginHunk(i);
      cur.templateLines.push(aLines[i]);
      i++;
    } else {
      beginHunk(i);
      cur.configuredLines.push(bLines[j]);
      j++;
    }
  }
  while (i < n) { beginHunk(i); cur.templateLines.push(aLines[i]); i++; }
  while (j < m) { beginHunk(i); cur.configuredLines.push(bLines[j]); j++; }
  flush();

  return hunks.map(h => ({
    ...h,
    type: h.templateLines.length && h.configuredLines.length ? "replace"
        : h.templateLines.length ? "delete" : "insert",
  }));
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

/**
 * Convert a hunk into a replacer item.
 *
 * Emits template and configured lines **verbatim** (no indent stripping).
 * The upstream replacer tries exact text match first (`content.includes(pattern)`),
 * which is deterministic for verbatim lines. Stripping common indent can mangle
 * hunks that span mixed-indent regions (e.g. GovCloud's long block delete that
 * crosses nested YAML + root sections) because the replacer's indent-aware
 * fallback assumes a single uniform indent prefix.
 *
 * For insert-only hunks, grab up to ANCHOR_CONTEXT_LINES preceding template
 * lines as the anchor; the replacement is anchor + inserted lines, so the
 * anchor's own indentation carries through unchanged.
 */
function hunkToItem(hunk, templateLines) {
  if (hunk.type === "insert") {
    const start = Math.max(0, hunk.startIdxTemplate - ANCHOR_CONTEXT_LINES);
    const anchor = templateLines.slice(start, hunk.startIdxTemplate);
    if (anchor.length === 0) {
      return {
        _warning: `insert hunk at line ${hunk.startIdxTemplate} has no preceding anchor (start-of-file insert)`,
        pattern: "",
        replacement: hunk.configuredLines.join("\n"),
      };
    }
    return {
      pattern: anchor.join("\n"),
      replacement: [...anchor, ...hunk.configuredLines].join("\n"),
    };
  }

  return {
    pattern: hunk.templateLines.join("\n"),
    replacement: hunk.configuredLines.join("\n"),
  };
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

    const item = hunkToItem(hunk, tLines);
    if (item._warning) {
      result.warnings.push(`${pair.rel}: ${item._warning}`);
      delete item._warning;
    }
    result.structuralItems.push(item);
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
  ANCHOR_CONTEXT_LINES,
};
