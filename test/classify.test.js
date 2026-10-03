const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  diffLines,
  splitLines,
  stripCommonIndent,
  templateLooksAdmin,
  lineLooksPlaceholder,
  hunkToItem,
  classifyPair,
  classifyAndDiff,
} = require("../src/classify");

test("splitLines strips single trailing empty line from text ending with \\n", () => {
  assert.deepEqual(splitLines("a\nb\n"), ["a", "b"]);
  assert.deepEqual(splitLines("a\nb"), ["a", "b"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines("\n"), [""]);
});

test("lineLooksPlaceholder: angle-bracket placeholder is admin", () => {
  assert.equal(lineLooksPlaceholder("    value: <budget-notifications>@example.com"), true);
  assert.equal(lineLooksPlaceholder("    value: <perimeter-email>"), true);
});

test("lineLooksPlaceholder: example.com is admin", () => {
  assert.equal(lineLooksPlaceholder("foo@example.com"), true);
});

test("lineLooksPlaceholder: UPDATE marker comment alone is NOT admin", () => {
  // Comment marker arrows like "<-----" and the word UPDATE must not
  // flag concrete values as admin (GovCloud HomeRegion is structural).
  assert.equal(
    lineLooksPlaceholder("    value: us-east-1 # <----- UPDATE TO YOUR HOME REGION"),
    false
  );
});

test("templateLooksAdmin: every non-blank template line must be placeholder-shaped", () => {
  assert.equal(
    templateLooksAdmin([
      "    value: <foo>@example.com",
      "",
      "    value: <bar>@example.com",
    ]),
    true
  );
  assert.equal(
    templateLooksAdmin([
      "    value: us-east-1 # <----- UPDATE",
      "    value: <foo>@example.com",
    ]),
    false
  );
  assert.equal(templateLooksAdmin([]), false);
  assert.equal(templateLooksAdmin([""]), false);
});

test("stripCommonIndent removes shared leading whitespace", () => {
  const { stripped, indent } = stripCommonIndent([
    "    a: 1",
    "    b: 2",
    "      c: 3",
  ]);
  assert.equal(indent, "    ");
  assert.deepEqual(stripped, ["a: 1", "b: 2", "  c: 3"]);
});

test("diffLines detects replace, delete, insert hunks", () => {
  const a = ["x", "same", "y"];
  const b = ["X", "same", "Y", "Z"];
  const hunks = diffLines(a, b);
  // First hunk replaces x->X, second replaces y->Y with trailing insert Z.
  // LCS can produce either shape; just assert the overall change set.
  const flattened = hunks.flatMap(h => [h.type, h.templateLines.join("|"), h.configuredLines.join("|")]);
  assert.ok(flattened.some(s => s.includes("x")));
  assert.ok(flattened.some(s => s.includes("X")));
  assert.ok(flattened.some(s => s.includes("Z")));
});

test("hunkToItem: insert hunk expands anchor until unique in template", () => {
  // t3 is unique in template -> anchor should be just "t3"
  const templateLines = ["t0", "t1", "t2", "t3", "t4"];
  const templateText = templateLines.join("\n");
  const hunk = {
    type: "insert",
    templateLines: [],
    configuredLines: ["new1", "new2"],
    startIdxTemplate: 4,
    startIdxConfigured: 0,
  };
  const item = hunkToItem(hunk, templateLines, templateText);
  assert.equal(item.pattern, "t3");
  assert.equal(item.replacement, "t3\nnew1\nnew2");
});

test("hunkToItem: insert hunk expands anchor across duplicates to find uniqueness", () => {
  // Line "dup" repeats; must expand backward to include unique "unique" line.
  const templateLines = ["unique", "dup", "x", "dup", "y"];
  const templateText = templateLines.join("\n");
  const hunk = {
    type: "insert",
    templateLines: [],
    configuredLines: ["new"],
    startIdxTemplate: 2, // inserting after first dup
    startIdxConfigured: 0,
  };
  const item = hunkToItem(hunk, templateLines, templateText);
  // Must contain "unique\ndup" (unique) and append new before "x"
  assert.ok(item.pattern.includes("unique"));
  assert.ok(item.replacement.endsWith("new"));
});

test("hunkToItem: start-of-file insert emits warning", () => {
  const item = hunkToItem(
    { type: "insert", templateLines: [], configuredLines: ["x"], startIdxTemplate: 0, startIdxConfigured: 0 },
    ["a", "b"],
    "a\nb"
  );
  assert.ok(item._warning);
});

test("hunkToItem: non-unique replace pattern gets expanded with preceding context", () => {
  // Repeating "tags:" block; replace must include unique preceding stanza header.
  const templateLines = ["- name: A", "tags:", "...", "- name: B", "tags:", "...", "end"];
  const templateText = templateLines.join("\n");
  const hunk = {
    type: "replace",
    templateLines: ["tags:", "..."],
    configuredLines: ["tags:", "modified"],
    startIdxTemplate: 1,
    startIdxConfigured: 1,
  };
  const item = hunkToItem(hunk, templateLines, templateText);
  // Pattern must have been extended backward to include "- name: A" (unique).
  assert.ok(item.pattern.startsWith("- name: A"));
  assert.ok(item.replacement.startsWith("- name: A"));
});

test("classifyPair: template-only file -> postActions removeFile", () => {
  const r = classifyPair({
    rel: "service-control-policies/x.json",
    templatePath: null,
    configuredPath: null,
    status: "template-only",
  });
  assert.deepEqual(r.postActions, [{ type: "removeFile", files: ["service-control-policies/x.json"] }]);
});

test("classifyPair: configured-only file warns, no items", () => {
  const r = classifyPair({
    rel: "new-file.yaml",
    templatePath: null,
    configuredPath: null,
    status: "configured-only",
  });
  assert.equal(r.structuralItems.length, 0);
  assert.ok(r.warnings[0].includes("new-file.yaml"));
});

function withTmpPair(templateText, configuredText, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lzaucreplgen-"));
  const t = path.join(dir, "t.yaml");
  const c = path.join(dir, "c.yaml");
  fs.writeFileSync(t, templateText);
  fs.writeFileSync(c, configuredText);
  try {
    return fn({ rel: "t.yaml", templatePath: t, configuredPath: c, status: "both" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("classifyPair: admin email swap routes to admin, not structural", () => {
  const r = withTmpPair(
    "foo: bar\nemail: <notify>@example.com\nbaz: qux\n",
    "foo: bar\nemail: alerts@mycorp.io\nbaz: qux\n",
    classifyPair
  );
  assert.equal(r.structuralItems.length, 0);
  assert.equal(r.adminChangeLines.length, 1);
  assert.ok(r.adminChangeLines[0].to.includes("alerts@mycorp.io"));
});

test("classifyPair: HomeRegion swap (concrete->concrete with UPDATE comment) is structural", () => {
  const r = withTmpPair(
    "foo: bar\nvalue: us-east-1 # <----- UPDATE TO YOUR HOME REGION\n",
    "foo: bar\nvalue: us-gov-west-1 # <----- UPDATE TO YOUR HOME REGION\n",
    classifyPair
  );
  assert.equal(r.adminChangeLines.length, 0);
  assert.equal(r.structuralItems.length, 1);
  assert.ok(r.structuralItems[0].pattern.includes("us-east-1"));
  assert.ok(r.structuralItems[0].replacement.includes("us-gov-west-1"));
});

test("classifyPair: deleting a placeholder block is structural (partition-level), not admin", () => {
  // GovCloud strips the entire BudgetsEmail stanza from replacements-config.yaml.
  // Even though the template lines are placeholder-shaped, deletion is a
  // partition-structural change and must appear in the replacements file.
  const r = withTmpPair(
    "foo: bar\n  - key: BudgetsEmail\n    type: String\n    value: <notify>@example.com\nbaz: qux\n",
    "foo: bar\nbaz: qux\n",
    classifyPair
  );
  assert.equal(r.adminChangeLines.length, 0);
  assert.equal(r.structuralItems.length, 1);
  assert.equal(r.structuralItems[0].replacement, "");
  assert.ok(r.structuralItems[0].pattern.includes("BudgetsEmail"));
});

test("classifyPair: identical files produce no items", () => {
  const r = withTmpPair("a: 1\nb: 2\n", "a: 1\nb: 2\n", classifyPair);
  assert.equal(r.structuralItems.length, 0);
  assert.equal(r.adminChangeLines.length, 0);
});

test("classifyPair: trailing-newline-only differences are ignored", () => {
  // Both files semantically identical; one has trailing \n, the other doesn't.
  const r = withTmpPair("a: 1\nb: 2\n", "a: 1\nb: 2", classifyPair);
  assert.equal(r.structuralItems.length, 0);
  assert.equal(r.adminChangeLines.length, 0);
});

test("classifyAndDiff: aggregates postActions across multiple template-only files", () => {
  const pairs = [
    { rel: "a.json", status: "template-only", templatePath: null, configuredPath: null },
    { rel: "b.json", status: "template-only", templatePath: null, configuredPath: null },
  ];
  const { fileEntries } = classifyAndDiff(pairs);
  const pa = fileEntries.find(e => e._postActions);
  assert.ok(pa);
  assert.deepEqual(pa._postActions, [{ type: "removeFile", files: ["a.json", "b.json"] }]);
});
