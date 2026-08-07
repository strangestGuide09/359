import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const auditPath = new URL("../support/restock_history_audit.sql", import.meta.url);

function executableSql(source) {
  return source
    .replace(/--[^\n]*/g, "")
    .replace(/'(?:''|[^'])*'/g, "''")
    .trim();
}

test("Possible buys audit is one balanced read-only SQL statement", async () => {
  const source = await readFile(auditPath, "utf8");
  const sql = executableSql(source);
  let depth = 0;
  for (const character of sql) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    assert.ok(depth >= 0, "a closing parenthesis must have an opening parenthesis");
  }
  assert.equal(depth, 0, "SQL parentheses must be balanced");
  assert.equal((sql.match(/;/g) || []).length, 1, "audit must return exactly one SQL result");
  assert.match(sql, /^with\s+reviewed_items\s+as\s*\(/i);
  assert.match(sql, /\)\s*select[\s\S]+possible_buys_eligible[\s\S]+eligibility_reason[\s\S]+;$/i);
  assert.doesNotMatch(sql, /\b(?:insert|update|delete|merge|truncate|alter|drop|create|grant|revoke)\b/i);
});

test("Possible buys audit distinguishes eligibility from diagnostics", async () => {
  const source = await readFile(auditPath, "utf8");
  assert.match(source, /distinct_qualifying_dates >= 2/);
  assert.match(source, /then 'eligible now'/);
  assert.match(source, /then 'needs a tracked purchase on another date'/);
  assert.match(source, /then 'untracked'/);
  assert.match(source, /then 'personal item excluded'/);
  assert.match(source, /then 'fee\/charge excluded'/);
  assert.doesNotMatch(source, /\bi\.id\b|item_id/);
});
