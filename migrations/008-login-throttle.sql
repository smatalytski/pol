-- The login throttle's counter (lib/auth/throttle.ts). One row, id pinned to 1
-- by the CHECK, so the state can never fork into competing rows.
--
-- It lives in the database rather than in memory because a redeploy restarts
-- the service: an in-memory counter would hand an attacker a fresh allowance
-- every deploy, which is exactly when nobody is watching.
CREATE TABLE login_throttle (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  failures INTEGER NOT NULL DEFAULT 0,
  blocked_until INTEGER
);

INSERT INTO login_throttle (id, failures, blocked_until) VALUES (1, 0, NULL);
