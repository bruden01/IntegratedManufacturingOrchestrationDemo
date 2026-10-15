-- Supplier B (logistics) fleet management: tugger registry and which tugger carries which seat set.
CREATE TABLE IF NOT EXISTS tuggers (
    id         TEXT PRIMARY KEY,       -- T1, T2, T3
    model      TEXT NOT NULL,
    capacity   INTEGER NOT NULL,       -- seat sets per trip
    state      TEXT NOT NULL,          -- MOVING, FAULT
    fault_code TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assignments (
    seq        INTEGER PRIMARY KEY,    -- build sequence of the seat set
    tugger_id  TEXT NOT NULL REFERENCES tuggers(id),
    updated_at TEXT NOT NULL
);

-- Requests into Supplier B's fleet system: Vantiq asks for a tugger for a seat set, Supplier B honors it and confirms.
CREATE TABLE IF NOT EXISTS tugger_requests (
    vin        TEXT PRIMARY KEY,
    seq        INTEGER NOT NULL,
    tugger_id  TEXT NOT NULL REFERENCES tuggers(id),
    state      TEXT NOT NULL,          -- REQUESTED, CONFIRMED
    updated_at TEXT NOT NULL
);
