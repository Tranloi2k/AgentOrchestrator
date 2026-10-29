import test from "node:test";
import assert from "node:assert/strict";
import { parseCron, cronMatches, nextRuns } from "./cron.js";

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);

test("fields, ranges, steps and lists", () => {
  const weekdays7 = parseCron("0 7 * * 1-5");
  assert.ok(cronMatches(weekdays7, at(2026, 10, 29, 7, 0)), "Thursday 07:00");
  assert.ok(!cronMatches(weekdays7, at(2026, 11, 1, 7, 0)), "Sunday");
  assert.ok(!cronMatches(weekdays7, at(2026, 10, 29, 7, 1)));

  const every15 = parseCron("*/15 9-17 * * *");
  assert.ok(cronMatches(every15, at(2026, 1, 5, 9, 45)));
  assert.ok(!cronMatches(every15, at(2026, 1, 5, 18, 0)));

  assert.ok(cronMatches(parseCron("0 0 1,15 * *"), at(2026, 3, 15, 0, 0)));
  assert.ok(cronMatches(parseCron("@daily"), at(2026, 3, 15, 0, 0)));
  assert.ok(cronMatches(parseCron("0 8 * * 7"), at(2026, 11, 1, 8, 0)), "7 = Sunday too");
});

test("day-of-month OR day-of-week when both are set, like standard cron", () => {
  const c = parseCron("0 0 13 * 5");
  assert.ok(cronMatches(c, at(2026, 10, 13, 0, 0)), "the 13th");
  assert.ok(cronMatches(c, at(2026, 10, 30, 0, 0)), "a Friday");
});

test("invalid expressions are refused with a reason", () => {
  assert.throws(() => parseCron("0 7 * *"), /5 trường/);
  assert.throws(() => parseCron("60 * * * *"), /phút/);
  assert.throws(() => parseCron("0 7 * * mon"), /thứ/);
  assert.throws(() => parseCron("*/0 * * * *"), /Bước/);
});

test("next runs preview", () => {
  const next = nextRuns("30 6 * * *", 2, at(2026, 10, 29, 7, 0));
  assert.deepEqual(next.map((d) => [d.getDate(), d.getHours(), d.getMinutes()]), [[30, 6, 30], [31, 6, 30]]);
});
