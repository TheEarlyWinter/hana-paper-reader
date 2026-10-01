// Pure receipt contract shared by the UI and the App server. No host or DOM access.
export const isMigrationPlanId = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export const isMigrationHash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = value => value && typeof value === "object" && !Array.isArray(value);
const invalid = () => { throw new TypeError("Invalid migration receipt"); };
const rowBasis = rows => JSON.stringify(rows.map(row => [row.paperHash, row.title, row.action, row.notes, row.bookmarks, row.tasks, row.assets]));

export function validateMigrationReceipt(value, expected = null) {
  if (!object(value) || value.format !== "hana-paper-reader-migration-receipt" || value.version !== 1
      || !isMigrationPlanId(value.planId) || !isMigrationHash(value.sourceFingerprint) || !isMigrationHash(value.bundleFingerprint)
      || value.policy !== "keep-target-isolate-source" || value.acceptance !== "not-performed"
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || !["prepared", "importing", "completed", "partial", "interrupted"].includes(value.state)
      || ![value.rows, value.imported, value.kept, value.failed].every(Array.isArray) || value.rows.length > 1000) invalid();
  const rows = new Set();
  for (const row of value.rows) {
    if (!object(row) || !isMigrationHash(row.paperHash) || rows.has(row.paperHash) || typeof row.title !== "string" || row.title.length > 300
        || !["import", "keep-target-isolate-source"].includes(row.action)
        || ![row.notes, row.bookmarks, row.tasks, row.assets].every(count => Number.isSafeInteger(count) && count >= 0)) invalid();
    rows.add(row.paperHash);
  }
  const accounted = new Set();
  for (const hash of [...value.imported, ...value.kept]) {
    if (!isMigrationHash(hash) || !rows.has(hash) || accounted.has(hash)) invalid();
    accounted.add(hash);
  }
  for (const item of value.failed) {
    if (!object(item) || !isMigrationHash(item.paperHash) || !rows.has(item.paperHash) || accounted.has(item.paperHash)
        || typeof item.code !== "string" || !item.code) invalid();
    accounted.add(item.paperHash);
  }
  if (value.state === "prepared" && accounted.size !== 0
      || value.state === "completed" && (value.failed.length !== 0 || accounted.size !== rows.size)
      || value.state === "partial" && value.failed.length === 0
      || value.currentPaper !== undefined && (!isMigrationHash(value.currentPaper) || !rows.has(value.currentPaper) || accounted.has(value.currentPaper))
      || value.finishedAt !== undefined && (typeof value.finishedAt !== "string" || !Number.isFinite(Date.parse(value.finishedAt)))) invalid();
  if (expected && (value.planId !== expected.planId || value.sourceFingerprint !== expected.sourceFingerprint
      || value.bundleFingerprint !== expected.bundleFingerprint || value.createdAt !== expected.createdAt
      || rowBasis(value.rows) !== rowBasis(expected.rows))) invalid();
  return value;
}
