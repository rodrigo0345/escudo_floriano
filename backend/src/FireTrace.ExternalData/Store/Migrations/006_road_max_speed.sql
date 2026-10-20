-- Limite de velocidade de cada troço (etiqueta OSM `maxspeed`, km/h). Nulo = sem limite conhecido: vale a velocidade típica da classe da via.
ALTER TABLE road_edges ADD COLUMN IF NOT EXISTS max_speed_kmh double precision;
