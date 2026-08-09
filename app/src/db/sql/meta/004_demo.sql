-- Phase 10 — the public demo. HANDOFF §9 is the design and the argument.
--
-- Three additions, and the shape of them is the whole decision: a *pool* of
-- pre-provisioned accounts handed out on a lease, rather than one shared login
-- with a published password. §9a has the three separate reasons a shared
-- account fails; the short one is that every rail protecting a student
-- (CONNECTION LIMIT, the 50 MB quota, the pooled backends) is per role, so a
-- shared account shares them.

-- --- which accounts belong to the demo ---------------------------------------
--
-- Two different questions, and they are deliberately answered by two different
-- things:
--
--   `app_user.demo`      — "this account is part of the demo world". Excluded
--                          from every report about real people (§9i), and
--                          subject to the caps (§9f).
--   a `demo_lease` row   — "this account is handed out to visitors". A strict
--                          subset: the three students in a demo teacher's class
--                          are `demo` and have no lease, because nobody ever
--                          logs in as them.
--
-- Collapsing the two into one flag was the first draft and it is wrong in the
-- direction that matters: the fixture students would then be claimable, and a
-- visitor would land inside the roster another visitor is looking at.
ALTER TABLE app_user ADD COLUMN demo boolean NOT NULL DEFAULT false;

-- An admin has no Postgres identity and nothing to reset, so a demo admin is a
-- thing this code could not honour. Failing at the INSERT is better than
-- discovering it in `claim`.
ALTER TABLE app_user ADD CONSTRAINT app_user_demo_ck CHECK (NOT demo OR role <> 'admin');

CREATE INDEX app_user_demo_idx ON app_user (demo) WHERE demo;

-- --- the session ceiling -----------------------------------------------------
--
-- A demo session must stop after 30 minutes and must not be extendable by
-- activity. The mechanism already existed: `refreshSession` clamps rolling
-- extension with `LEAST(next, created_at + absoluteTtl)`, so this is that
-- expression with one more term in it (§9g).
--
-- Nullable, and NULL means "no extra ceiling" — every existing session and
-- every real account. Making it NOT NULL DEFAULT with the global 7-day value
-- would have worked too, and would have quietly moved the ceiling for real
-- accounts from config into rows, where a config change no longer reaches it.
--
-- **Deliberately not derived from `app_user.demo` at read time.** That would
-- make the ceiling a property of the account rather than of the session, so a
-- lease that ended would still leave the *next* visitor's clock running from
-- whatever the row said, and it would put a join in the hot path every request
-- takes.
ALTER TABLE session ADD COLUMN hard_expires_at timestamptz;

-- --- the pool ----------------------------------------------------------------
--
-- One row per claimable account. Presence is what makes an account claimable;
-- `expires_at` is the lease.
--
-- `expires_at IS NULL OR expires_at < now()` means free. Two columns rather than
-- a `state` enum because there is no third state and a claim is then one
-- `UPDATE … RETURNING` with `FOR UPDATE SKIP LOCKED` underneath it — which is
-- what makes two visitors clicking in the same second get two different
-- accounts instead of one row and one error.
--
-- **No `kind` column.** Which side of the demo an account is on is
-- `app_user.role`, which is already the authoritative answer and already
-- constrained; a second copy here could disagree with it, and the disagreement
-- would surface as a visitor being handed the wrong page.
CREATE TABLE demo_lease (
  user_id    bigint      PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  -- NULL until first claimed. Kept afterwards so `/api/admin/demo` can say when
  -- the pool was last busy without reading the audit log.
  claimed_at timestamptz,
  expires_at timestamptz,
  -- How many visitors this slot has served. The only number that says whether
  -- the pool is sized right, and it costs one increment per claim.
  claims     bigint      NOT NULL DEFAULT 0,
  -- When the schema was last wiped. Diverges from `claimed_at` only when a
  -- reset failed, which is exactly the case worth being able to see.
  reset_at   timestamptz
);

-- The claim query's index: free slots only, so the scan is over the free list
-- rather than the pool.
CREATE INDEX demo_lease_free_idx ON demo_lease (expires_at NULLS FIRST);
