"""When the aircraft must stop: firefighting aircraft fly by day only (``AerialSpec.dayOnly``, ``Rules.aerial.limits.dayOnly``).

The weather series the backend serves has no solar radiation, so sunset is computed from the date and the place (the NOAA solar position equations, the usual
low-precision form: good to a minute or two, plenty for "can it still fly at T+N").
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone

SUN_ALTITUDE_DEG = -0.833  # sunset: the sun's upper limb on the horizon, with refraction


def sunset(day: datetime, lat: float, lon: float) -> datetime:
    """Sunset (UTC) on ``day``'s date at (lat, lon); polar day/night fall back to midnight/noon."""
    n = day.timetuple().tm_yday
    gamma = 2 * math.pi / 365 * (n - 1)
    eqtime = 229.18 * (0.000075 + 0.001868 * math.cos(gamma) - 0.032077 * math.sin(gamma) - 0.014615 * math.cos(2 * gamma) - 0.040849 * math.sin(2 * gamma))
    decl = (0.006918 - 0.399912 * math.cos(gamma) + 0.070257 * math.sin(gamma) - 0.006758 * math.cos(2 * gamma) + 0.000907 * math.sin(2 * gamma)
            - 0.002697 * math.cos(3 * gamma) + 0.00148 * math.sin(3 * gamma))
    phi = math.radians(lat)
    cos_ha = (math.cos(math.radians(90 - SUN_ALTITUDE_DEG)) / (math.cos(phi) * math.cos(decl))) - math.tan(phi) * math.tan(decl)
    midnight = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    if cos_ha <= -1:
        return midnight + timedelta(days=1)
    if cos_ha >= 1:
        return midnight + timedelta(hours=12)
    ha = math.degrees(math.acos(cos_ha))
    minutes = 720 - 4 * (lon - ha) - eqtime  # UTC minutes after midnight
    return midnight + timedelta(minutes=minutes)


def minutes_to_sunset(start_iso: str, lat: float, lon: float) -> float:
    """Minutes from the scenario start (RFC 3339) until that day's sunset there (negative once it has set)."""
    start = datetime.fromisoformat(start_iso.replace("Z", "+00:00"))
    if start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return (sunset(start.astimezone(timezone.utc), lat, lon) - start).total_seconds() / 60.0
