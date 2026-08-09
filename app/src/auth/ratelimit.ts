/**
 * Login throttling (architecture §3, "brute-forcing the app login").
 *
 * In-memory on purpose: there is exactly one app container, and a restart
 * clearing the counters is not a meaningful attack — an attacker cannot cause
 * the restart. Redis for this would be a dependency bought with nothing.
 *
 * Two independent budgets, because they defend different things:
 *   - per account, against someone grinding one student's short slip password;
 *   - per IP, against someone grinding the whole class roster from one machine.
 *
 * Only *failures* count. A student who logs in correctly forty times during a
 * lesson is never throttled.
 */

interface Window {
  count: number;
  resetAt: number;
}

export class FailureLimiter {
  readonly #windows = new Map<string, Window>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  #window(key: string, now: number): Window {
    const existing = this.#windows.get(key);
    if (existing && existing.resetAt > now) return existing;
    const fresh = { count: 0, resetAt: now + this.windowMs };
    this.#windows.set(key, fresh);
    return fresh;
  }

  /** Milliseconds until this key is allowed again, or 0 if it is allowed now. */
  retryAfterMs(key: string, now = Date.now()): number {
    const w = this.#windows.get(key);
    if (!w || w.resetAt <= now || w.count < this.max) return 0;
    return w.resetAt - now;
  }

  fail(key: string, now = Date.now()): void {
    this.#window(key, now).count += 1;
  }

  /** Called on a successful login, so one typo does not linger in the budget. */
  clear(key: string): void {
    this.#windows.delete(key);
  }

  /** Drop windows that have lapsed. Unbounded growth would otherwise be a slow leak. */
  sweep(now = Date.now()): void {
    for (const [key, w] of this.#windows) {
      if (w.resetAt <= now) this.#windows.delete(key);
    }
  }

  get size(): number {
    return this.#windows.size;
  }
}

/**
 * The per-account budget: 10 tries per 15 minutes, while still forgiving a
 * student who mistypes "gruen" as "grün" a few times.
 *
 * Sized against `generateSlipPassword`'s **29.1 bits** — 960 tries a day
 * against 590 million candidates. Do not restate that figure from memory: this
 * comment used to say "~22 bits … an exhaustive search take years" about a
 * generator that produced 14.1 bits, where the real answer was nine days per
 * targeted account. If the word lists in `auth/password.ts` change, this number
 * changes with them.
 */
export const accountLimiter = new FailureLimiter(10, 15 * 60 * 1000);

/**
 * Generous, because a whole class shares one school NAT address and a first
 * lesson produces a lot of honest typing errors: 25 students mistyping a slip
 * password three times each is 75 honest failures in the first ten minutes, and
 * throttling the entire room mid-lesson — with no way for the teacher to reset
 * it short of restarting the container — would be far worse than the attack it
 * prevents.
 *
 * Callers must also `clear()` this on a successful login. Every success is
 * evidence the address is a classroom rather than a script, and the per-account
 * budget still binds each individual target.
 */
export const ipLimiter = new FailureLimiter(200, 15 * 60 * 1000);

/**
 * The ceiling a success cannot lift, and the reason `ipLimiter` is still
 * allowed to be `clear()`ed.
 *
 * `ipLimiter` alone was not a budget at all: **every student has a valid
 * account**, so an attacker interleaves one login of their own after every 199
 * failures, `clear()` deletes the window outright, and the 200/15 min ceiling
 * never binds. The whole-roster grind that limiter exists to stop cost one
 * extra request per 199 tries.
 *
 * Deleting the `clear()` instead would have been the wrong fix — it is what
 * keeps an honest classroom out of a shared lockout, and the comment above is
 * still right about that. So: a second window, an order of magnitude looser and
 * four times longer, that nothing ever clears. 500 an hour leaves the 75-honest-
 * failures lesson a factor of six of headroom while capping a grinder at 12 000
 * a day — against 590 million candidates, which is the point.
 */
export const ipHardLimiter = new FailureLimiter(500, 60 * 60 * 1000);

/**
 * A budget on *requests*, not failures — the first such thing in this app, and
 * added for phase 10 (HANDOFF §9h).
 *
 * Everything above counts login failures, which is the right shape for a
 * password guess and the wrong one for a public demo: a visitor there holds a
 * valid session, so nothing they do is a failure and none of the limiters
 * above ever sees them. What bounds their *database* is already strong and
 * per-role — `statement_timeout`, the watchdog, four connections, the 50 MB
 * quota — so this exists for the HTTP layer alone.
 *
 * 600 per 5 minutes is two a second sustained. The number is set against the
 * busiest honest page rather than against an attacker: the lesson view polls,
 * the schema browser fans out a handful of calls per click, and a classroom
 * behind one NAT address is 25 people doing that at once. Anything under a few
 * hundred would have to be tuned by whoever gets throttled during a lesson,
 * which is the failure this must not have.
 *
 * Not `clear()`ed by anything. §4-era experience with `ipLimiter` is the reason:
 * a budget a successful request resets is not a budget.
 */
export const ipRequestLimiter = new FailureLimiter(600, 5 * 60 * 1000);

/**
 * The demo claim, which gets its own budget an order of magnitude tighter.
 *
 * A claim is the most expensive public thing in the app: it drops and recreates
 * a schema, and may drop several more. Ten in fifteen minutes from one address
 * is far more than a person evaluating the app can use — the pool holds eight —
 * and it is the difference between a stranger trying the demo and a stranger
 * cycling the pool to keep it empty for everyone else.
 */
export const demoClaimLimiter = new FailureLimiter(10, 15 * 60 * 1000);

let sweeper: NodeJS.Timeout | undefined;

export function startLimiterSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(
    () => {
      accountLimiter.sweep();
      ipLimiter.sweep();
      ipHardLimiter.sweep();
      ipRequestLimiter.sweep();
      demoClaimLimiter.sweep();
    },
    5 * 60 * 1000,
  );
  sweeper.unref();
}

export function stopLimiterSweeper(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = undefined;
}
