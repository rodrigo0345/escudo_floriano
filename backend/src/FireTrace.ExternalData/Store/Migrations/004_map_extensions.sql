-- Instalações vulneráveis (escolas, lares, abrigos…), caminhos florestais e aceiros. Remove o resto da API antiga (as corridas passam a ficar em ficheiros).
ALTER TABLE facilities DROP CONSTRAINT IF EXISTS facilities_type_check;
ALTER TABLE facilities ADD CONSTRAINT facilities_type_check CHECK (type IN (
  'fire_station','gnr','psp','civil_protection','inem','hospital','health_centre','town_hall',
  'school','care_home','shelter','heliport','camp_site','fuel_station'));
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS capacity int;
ALTER TABLE facilities ADD COLUMN IF NOT EXISTS vulnerable boolean NOT NULL DEFAULT false;

ALTER TABLE road_edges ADD COLUMN IF NOT EXISTS off_road boolean NOT NULL DEFAULT false;
ALTER TABLE road_edges ADD COLUMN IF NOT EXISTS tracktype text;
ALTER TABLE road_edges ADD COLUMN IF NOT EXISTS width_m double precision;

CREATE TABLE IF NOT EXISTS firebreaks (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('firebreak','fuel_management_strip','primary_network','natural_barrier')),
  name text,
  width_m double precision,
  maintained boolean NOT NULL DEFAULT true,
  source text NOT NULL,
  geom geometry(Geometry, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS firebreaks_geom ON firebreaks USING gist (geom);
CREATE INDEX IF NOT EXISTS firebreaks_loc ON firebreaks (location_id, kind);

DROP TABLE IF EXISTS sim_runs;
