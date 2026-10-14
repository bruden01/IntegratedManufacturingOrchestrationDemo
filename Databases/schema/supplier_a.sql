-- Supplier A (seating) ERP/WMS: seat-set records and spare-seat inventory.
CREATE TABLE IF NOT EXISTS seat_sets (
    vin        TEXT PRIMARY KEY,
    seq        INTEGER NOT NULL,
    seat_spec  TEXT NOT NULL,
    stage      TEXT NOT NULL,          -- QUEUED, PICKING, SEQUENCED, STAGED, ON_TUGGER, LINE_SIDE
    hold       INTEGER NOT NULL DEFAULT 0,
    defect     TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS seat_inventory (
    bin        TEXT PRIMARY KEY,       -- warehouse bin, e.g. B-14
    seat_spec  TEXT NOT NULL,
    on_hand    INTEGER NOT NULL,
    reserved   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);
