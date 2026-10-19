-- Intensidade da linha de fogo (kW/m, uint16 LE) e flags (bit0 copas, bit1 faíscas) da corrida representativa.
ALTER TABLE sim_runs ADD COLUMN IF NOT EXISTS intensity bytea;
ALTER TABLE sim_runs ADD COLUMN IF NOT EXISTS flags bytea;
