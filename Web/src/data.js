// Mock data. Replaced by Vantiq-backed state once the simulator is wired up.

export const BASE_VEHICLES = [
  { seq: 2041, vin: '…7K1042', vehicle: 'Traveler · Terra Gray', seat: 'Vinyl · Black · Heated', status: 'On tugger' },
  { seq: 2042, vin: '…7K1043', vehicle: 'Terra · Moss', seat: 'Cloth · Slate', status: 'On tugger' },
  { seq: 2043, vin: '…7K1044', vehicle: 'Traveler · Sand', seat: 'Vinyl · Tan · Heated', status: 'Staged' },
  { seq: 2044, vin: '…7K1045', vehicle: 'Terra · Terra Gray', seat: 'Cloth · Black', status: 'Sequenced' },
  { seq: 2045, vin: '…7K1046', vehicle: 'Traveler · Moss', seat: 'Vinyl · Black', status: 'Sequenced' },
  { seq: 2046, vin: '…7K1047', vehicle: 'Terra · Sand', seat: 'Cloth · Tan', status: 'Picking' },
  { seq: 2047, vin: '…7K1048', vehicle: 'Traveler · Slate', seat: 'Vinyl · Black · Heated', status: 'Picking' },
  { seq: 2048, vin: '…7K1049', vehicle: 'Terra · Moss', seat: 'Cloth · Slate', status: 'Queued' },
];

// Seconds until each position is needed at line side.
export const NEED_SECONDS = [860, 1040, 1220, 1400, 1580, 1760, 1940, 2120];

export const BASE_SLACK_SECONDS = 860;
export const DAMAGE_SLACK_COST = 160;
export const TUGGER_SLACK_COST = 330;
export const WATCH_THRESHOLD_SECONDS = 600;

export const EVENT_SAMPLE = `{
  "type": "PartSequenced",
  "vin": "…7K1045",
  "station": "SEQ-3",
  "source": "supplier-a/rest",
  "ts": "06:42:19Z"
}`;

export const SOURCES = [
  { name: 'Plant MES', proto: 'Message bus · build-order broadcast', detail: 'Vehicle sequence, trim, option mix' },
  { name: 'Supplier A · Seating', proto: 'REST · their MES and ERP', detail: 'Pick, sequence, quality scans, inventory' },
  { name: 'Supplier B · Tugger fleet', proto: 'MQTT · OPC UA', detail: 'Position, load, fault codes' },
];
