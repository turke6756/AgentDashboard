import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { computeNextFireAt, evaluateUntilBoundary, firstFutureDailySlot } from './recurrence';

type TestCase = { name: string; run: () => void };

const tests: TestCase[] = [];
const test = (name: string, run: () => void): void => {
  tests.push({ name, run });
};

test('interval advances from the prior slot', () => {
  assert.equal(computeNextFireAt({ kind: 'interval', everyMs: 60_000 }, 100_000, 100_000), 160_000);
});

test('REACHABILITY:cron-recurrence late wake skips every missed slot after one due occurrence', () => {
  assert.equal(computeNextFireAt({ kind: 'interval', everyMs: 60_000 }, 123_000, 400_000), 423_000);
});

test('until boundary is inclusive and exhausts when the next slot crosses it', () => {
  assert.deepEqual(evaluateUntilBoundary(200, 300, 200), {
    claimable: true,
    nextFireAt: null,
    exhausted: true,
  });
  assert.deepEqual(evaluateUntilBoundary(201, 300, 200), {
    claimable: false,
    nextFireAt: null,
    exhausted: true,
  });
  assert.deepEqual(evaluateUntilBoundary(200, 200, 200), {
    claimable: true,
    nextFireAt: 200,
    exhausted: false,
  });
});

function runDstChild(): void {
  const springPrior = new Date(2026, 2, 7, 2, 30).getTime();
  const springNext = computeNextFireAt({ kind: 'daily', atMinuteOfDay: 150 }, springPrior, springPrior);
  const spring = new Date(springNext);
  assert.deepEqual(
    [spring.getFullYear(), spring.getMonth(), spring.getDate(), spring.getHours(), spring.getMinutes()],
    [2026, 2, 8, 3, 0],
    'spring-forward gap must resolve to the next valid local instant',
  );

  const fallPrior = new Date(2026, 9, 31, 1, 30).getTime();
  const fallNext = computeNextFireAt({ kind: 'daily', atMinuteOfDay: 90 }, fallPrior, fallPrior);
  const fall = new Date(fallNext);
  assert.deepEqual(
    [fall.getFullYear(), fall.getMonth(), fall.getDate(), fall.getHours(), fall.getMinutes()],
    [2026, 10, 1, 1, 30],
  );
  assert.equal(fall.getTimezoneOffset(), 420, 'fall-back overlap must choose the first occurrence');

  const beforeSpringGap = new Date(2026, 2, 8, 1, 0).getTime();
  const springInitial = new Date(firstFutureDailySlot(beforeSpringGap, 150));
  assert.deepEqual(
    [springInitial.getFullYear(), springInitial.getMonth(), springInitial.getDate(), springInitial.getHours(), springInitial.getMinutes()],
    [2026, 2, 8, 3, 0],
  );
  const afterSpringGap = new Date(2026, 2, 8, 3, 1).getTime();
  const springTomorrow = new Date(firstFutureDailySlot(afterSpringGap, 150));
  assert.deepEqual(
    [springTomorrow.getFullYear(), springTomorrow.getMonth(), springTomorrow.getDate(), springTomorrow.getHours(), springTomorrow.getMinutes()],
    [2026, 2, 9, 2, 30],
  );

  const beforeFallFirst = new Date(2026, 10, 1, 1, 0).getTime();
  const fallInitial = new Date(firstFutureDailySlot(beforeFallFirst, 90));
  assert.equal(fallInitial.getTimezoneOffset(), 420, 'initial overlap slot must choose the first occurrence');
  const afterFallFirst = Date.UTC(2026, 10, 1, 9, 0);
  const fallTomorrow = new Date(firstFutureDailySlot(afterFallFirst, 90));
  assert.deepEqual(
    [fallTomorrow.getFullYear(), fallTomorrow.getMonth(), fallTomorrow.getDate(), fallTomorrow.getHours(), fallTomorrow.getMinutes()],
    [2026, 10, 2, 1, 30],
    'arming after the first overlap occurrence must not choose the repeated slot',
  );
}

if (process.argv.includes('--dst-child')) {
  runDstChild();
  process.exit(0);
}

test('daily recurrence handles the host-local spring gap and fall overlap', () => {
  execFileSync(process.execPath, [__filename, '--dst-child'], {
    env: { ...process.env, TZ: 'America/Los_Angeles' },
    stdio: 'inherit',
  });
});

let failed = 0;
for (const entry of tests) {
  try {
    entry.run();
    console.log(`  ok  ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${entry.name}`);
    console.error(error);
  }
}

if (failed > 0) {
  console.error(`recurrence.test: ${tests.length - failed} passed, ${failed} failed`);
  process.exit(1);
}

console.log(`recurrence.test: ${tests.length} passed`);
