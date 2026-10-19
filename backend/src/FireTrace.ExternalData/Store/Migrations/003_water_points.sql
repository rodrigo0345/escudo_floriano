-- Bocas de incêndio e pontos de água (OSM): hidrantes, tanques, albufeiras, charcas, piscinas.
CREATE TABLE IF NOT EXISTS water_points (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('hydrant','dry_hydrant','tank','reservoir','pond','swimming_pool')),
  name text NOT NULL,
  ref text,
  capacity_l double precision,
  capacity_estimated boolean NOT NULL DEFAULT false,
  flow_lpm double precision,
  area_m2 double precision,
  diameter_mm double precision,
  hydrant_type text,
  truck_accessible boolean NOT NULL DEFAULT false,
  helicopter_accessible boolean NOT NULL DEFAULT false,
  nearest_road_id int,
  road_distance_m double precision,
  access text NOT NULL DEFAULT 'unknown',
  source text NOT NULL,
  osm_id text,
  geom geometry(Point, 4326) NOT NULL
);
CREATE INDEX IF NOT EXISTS water_points_geom ON water_points USING gist (geom);
CREATE INDEX IF NOT EXISTS water_points_loc ON water_points (location_id, kind);
