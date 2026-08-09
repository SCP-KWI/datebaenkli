-- 0.11.0 — the first-run tour. HANDOFF §17 is the design.
--
-- One column. What is worth writing down is why it is a column at all, because
-- `localStorage` was the obvious answer and it is wrong here specifically.
--
-- **The deployment is shared machines.** A class of 22 works in a computer room
-- and a browser profile outlives the person sitting at it. Per-browser state
-- means the first student of the day gets the tour and the next twenty-one do
-- not, on the day the tour is most needed. Per-account is the thing actually
-- being asked — "has *this person* seen it" — and it follows them to the laptop
-- they open at home, which is the same argument `locale` already makes one
-- column over.
--
-- Per-IP was considered and is worse than both: a school is one IP.
--
-- `timestamptz` and not `boolean`, for the reason every other lifecycle column
-- here is a timestamp: "when" answers "whether" for free, and the day someone
-- asks whether anybody is finishing the tour, a boolean has already thrown that
-- away. NULL means never.
--
-- **Demo accounts never have this set** and the app does not look at it for
-- them — a leased account is handed to a new visitor every half hour, so the
-- tour has to replay, and a column recording that the *previous* visitor saw it
-- would be a lie about a person who no longer exists. `routes/session.ts` is
-- where that decision lives; nothing here enforces it, and nothing should:
-- the account genuinely has no single "who" to record.

ALTER TABLE app_user ADD COLUMN tour_seen_at timestamptz;

COMMENT ON COLUMN app_user.tour_seen_at IS
  'When this account finished or skipped the first-run tour. NULL = never. '
  'Ignored for demo accounts, whose tour replays for every visitor.';
