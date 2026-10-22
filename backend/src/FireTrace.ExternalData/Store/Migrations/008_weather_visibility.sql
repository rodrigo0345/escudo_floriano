-- Visibilidade, CAPE e dia/noite de cada hora meteorológica (D1). `detail_version` 2 = hora obtida com estes campos; as anteriores são pedidas outra vez ao pedir esse período.
-- O arquivo ERA5 não tem visibilidade nem CAPE: ficam NULL nesses dias e o resto do sistema continua a funcionar (campos opcionais).
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS visibility_m real;
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS cape_jkg real;
ALTER TABLE weather_obs ADD COLUMN IF NOT EXISTS is_day boolean;
