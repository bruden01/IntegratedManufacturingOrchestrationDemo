-- Plant MES: the OEM's order database. One row per vehicle in the published build-order window.
CREATE TABLE IF NOT EXISTS build_orders (
    seq         INTEGER PRIMARY KEY,   -- position in the build sequence
    vin         TEXT NOT NULL UNIQUE,
    vehicle     TEXT NOT NULL,         -- model and color
    seat_spec   TEXT NOT NULL,         -- seat material, color, options
    rev         INTEGER NOT NULL,      -- build-order revision that last set this row
    need_in_sec INTEGER NOT NULL,      -- sim-seconds until the seat set is needed at line side, as of updated_at
    updated_at  TEXT NOT NULL
);
