"""The GNR cordon: every way into the fire zone closed, one patrol each, the mountain's own roads behind it."""
from __future__ import annotations

from typing import Any

from firetrace_agents.gnr import ACCESS_LEAD_MINUTES, plan_cordon


def road(road_id: str, coords: list[tuple[float, float]], cls: str = "tertiary", name: str | None = None) -> dict[str, Any]:
    from firetrace_agents.sectors import distance_m

    length = sum(distance_m(a[1], a[0], b[1], b[0]) for a, b in zip(coords, coords[1:]))
    return {"type": "Feature", "geometry": {"type": "LineString", "coordinates": [list(c) for c in coords]},
            "properties": {"id": road_id, "class": cls, "name": name, "lengthM": length}}


# A mountain road H crosses the fire zone between A and B; M climbs from B to a dead-end summit; W and E come in from either side and a bypass joins them
# (the outside world is one network). At lat 41, 0.001° of longitude is ~84 m.
A, B, SUMMIT = (0.050, 41.0), (0.055, 41.0), (0.055, 41.010)
ROADS = {r["properties"]["id"]: r for r in [
    road("H", [A, B], "unclassified", "Estrada do Monte"),
    road("M", [B, SUMMIT], "track"),
    road("W1", [(0.030, 41.0), (0.040, 41.0)]), road("W2", [(0.040, 41.0), A], name="EM 1"),
    road("E1", [B, (0.065, 41.0)], name="EM 2"), road("E2", [(0.065, 41.0), (0.075, 41.0)]),
    road("S1", [(0.030, 41.0), (0.030, 40.98)], "primary"), road("S2", [(0.030, 40.98), (0.075, 40.98)], "primary"), road("S3", [(0.075, 40.98), (0.075, 41.0)], "primary"),
]}
STATUS = [{"roadId": "H", "class": "unclassified", "cutProbability": 0.9, "cutAtMinute": {"p10": 40, "p50": 50, "p90": 60}, "reopenAtMinute": {"p50": 200, "p90": 260}}]


def test_every_way_into_the_fire_zone_gets_one_patrol_and_the_mountain_behind_it_is_closed_with_it() -> None:
    cordon = plan_cordon(STATUS, ROADS, decided_at=0, horizon=600, intensity_at=lambda m: 0.0)
    assert len(cordon) == 2  # from the west and from the east: one checkpoint each, not a patrol at both ends of every road
    assert all(c.access and len(c.ends) == 1 and c.lead_minutes == ACCESS_LEAD_MINUTES for c in cordon)
    points = sorted((round(c.ends[0]["lon"], 3), round(c.ends[0]["lat"], 3)) for c in cordon)
    assert points == [A, B]  # at the junctions where traffic comes in
    assert all("M" not in c.end_roads for c in cordon)  # the summit track is behind the cordon, not an access
    by_point = {(round(c.ends[0]["lon"], 3), round(c.ends[0]["lat"], 3)): c for c in cordon}
    assert by_point[A].end_roads == ["W2"] and by_point[B].end_roads == ["E1"]  # the patrol stands on the road from outside
    assert all(c.cut_p10 == 40 for c in cordon)  # closed before the fire reaches the road behind it


def test_a_road_that_leaves_the_map_is_a_way_in_not_a_dead_end_behind_the_fire() -> None:
    # N climbs from B to the north edge of the road data (the village beyond is off the map): clipped there, it looks like a dead end reached only through
    # the fire zone, but traffic comes down it from outside, so it needs its own checkpoint
    edge = {**ROADS, "N": road("N", [B, (0.055, 41.004), (0.055, 41.03)], "secondary", "EN norte"),
            "FAR": road("FAR", [(0.030, 40.98), (0.030, 40.97)], "primary")}  # the rest of the map, so the north end is the data's edge
    del edge["M"]
    cordon = plan_cordon(STATUS, edge, decided_at=0, horizon=600, intensity_at=lambda m: 0.0)
    assert any("N" in c.end_roads for c in cordon)


def test_no_fire_on_the_roads_means_no_cordon() -> None:
    assert plan_cordon([], ROADS, decided_at=0, horizon=600, intensity_at=lambda m: 0.0) == []
    late = [{**STATUS[0], "cutAtMinute": {"p10": 900, "p50": 950}}]
    assert plan_cordon(late, ROADS, decided_at=0, horizon=600, intensity_at=lambda m: 0.0) == []  # beyond the horizon
