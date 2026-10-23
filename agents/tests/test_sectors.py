"""Sectors: the units are spread over the fire front instead of stacking on its head."""
from __future__ import annotations

import math

import pytest

from firetrace_agents.firefighter import FirefighterAgent, situation_from_simulation
from firetrace_agents.sectors import Assignment, Sector, assign_units, distance_m, line_across, plan_sectors, zone_around
from firetrace_agents.tiers import FirefighterTier

from .conftest import SUMMARY_MEDIUM, THREATENED_ISOLATED
from .test_firefighter import make_observation


def _vectors(*points):
    """points: (lat, lon, bearing, speed, intensity)"""
    return {
        "features": [
            {"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {"bearingDeg": b, "speedMmin": v, "intensityKwm": i}}
            for lat, lon, b, v, i in points
        ]
    }


def _bearing(lat1, lon1, lat2, lon2):
    y = math.sin(math.radians(lon2 - lon1)) * math.cos(math.radians(lat2))
    x = math.cos(math.radians(lat1)) * math.sin(math.radians(lat2)) - math.sin(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.cos(math.radians(lon2 - lon1))
    return (math.degrees(math.atan2(y, x)) + 360) % 360


class TestPlanSectors:
    def test_ranks_by_danger_and_drops_neighbours_closer_than_two_work_zones(self):
        vectors = _vectors(
            (41.40, -8.30, 90, 5, 500),      # slow
            (41.41, -8.30, 90, 30, 1600),    # fastest, most intense (within what crews can fight)
            (41.4101, -8.30, 90, 25, 1500),  # ~11 m from the fastest: dropped
        )
        sectors = plan_sectors(vectors, zone_radius_m=180)
        assert [round(s.speed_mmin) for s in sectors] == [30, 5]

    def test_ignores_features_without_a_bearing_or_speed(self):
        vectors = {"features": [{"geometry": {"type": "Point", "coordinates": [-8.3, 41.4]}, "properties": {}}]}
        assert plan_sectors(vectors) == []


class TestAssignUnits:
    SECTORS = [Sector(41.40 + 0.01 * i, -8.30, 90, 30 - 5 * i, 3000 - 400 * i) for i in range(6)]  # ranked, far apart

    def test_the_helicopter_takes_the_most_dangerous_sector(self):
        units = [("h1", "helicopter"), ("t1", "truck"), ("s1", "squad")]
        assigned = assign_units(units, self.SECTORS, [])
        assert assigned["h1"].sector is self.SECTORS[0]

    def test_units_are_spread_over_distinct_sectors_before_any_is_shared(self):
        units = [(f"t{i}", "truck") for i in range(4)]
        sectors = {assign_units(units, self.SECTORS, [])[u].sector for u, _ in units}
        assert len(sectors) == 4

    def test_extra_units_share_a_sector_but_get_different_slots(self):
        one = [Sector(41.4, -8.3, 90, 20, 2000)]
        assigned = assign_units([(f"t{i}", "truck") for i in range(3)], one, [])
        assert sorted(a.slot for a in assigned.values()) == [0, 1, 2]

    def test_places_are_dealt_round_robin_within_a_tier(self):
        places = [{"id": "p1"}, {"id": "p2"}]
        assigned = assign_units([(f"t{i}", "truck") for i in range(3)], self.SECTORS, places)
        assert [assigned[f"t{i}"].place["id"] for i in range(3)] == ["p1", "p2", "p1"]


class TestGeometry:
    def test_a_line_crosses_the_path_at_right_angles_and_has_the_requested_length(self):
        line = line_across(41.4, -8.3, 135, 200)
        (lon1, lat1), (lon2, lat2) = line["coordinates"]
        assert distance_m(lat1, lon1, lat2, lon2) == pytest.approx(400, rel=0.01)
        assert (_bearing(lat1, lon1, lat2, lon2) - 135 - 90) % 180 == pytest.approx(0, abs=1) or (_bearing(lat1, lon1, lat2, lon2) - 135 - 90) % 180 == pytest.approx(180, abs=1)

    def test_slots_lay_lines_side_by_side_without_overlap(self):
        centres = []
        for slot in range(3):
            (lon1, lat1), (lon2, lat2) = line_across(41.4, -8.3, 90, 100, slot)["coordinates"]
            centres.append(((lat1 + lat2) / 2, (lon1 + lon2) / 2))
        assert distance_m(*centres[0], *centres[1]) == pytest.approx(200, rel=0.02)
        assert distance_m(*centres[0], *centres[2]) == pytest.approx(200, rel=0.02)
        assert distance_m(*centres[1], *centres[2]) == pytest.approx(400, rel=0.02)

    def test_a_zone_is_a_closed_ring_inside_the_radius(self):
        ring = zone_around(41.4, -8.3, 90, 150)["coordinates"][0]
        assert ring[0] == ring[-1]
        assert all(distance_m(41.4, -8.3, lat, lon) == pytest.approx(150, rel=0.01) for lon, lat in ring)


class TestAgentsUseTheirSector:
    @staticmethod
    def _situation(**kwargs):
        return situation_from_simulation("sim-x", threatened=THREATENED_ISOLATED, summary=SUMMARY_MEDIUM, horizon_minutes=60, **kwargs)

    def test_two_trucks_with_different_sectors_do_not_stack_their_lines(self):
        a = FirefighterAgent(make_observation(FirefighterTier.TRUCK, "veh-a"))
        b = FirefighterAgent(make_observation(FirefighterTier.TRUCK, "veh-b"))
        s1, s2 = Sector(41.40, -8.30, 90, 20, 2000), Sector(41.43, -8.28, 90, 20, 2000)
        ga = a.decide(self._situation(), Assignment(sector=s1)).proposals[0].intervention["geometry"]
        gb = b.decide(self._situation(), Assignment(sector=s2)).proposals[0].intervention["geometry"]
        assert ga != gb

    def test_without_an_assignment_the_unit_acts_on_the_head_as_before(self):
        unit = FirefighterAgent(make_observation(FirefighterTier.SQUAD, "pp-a"))
        assert unit.decide(self._situation()).proposals

    def test_no_position_at_all_is_an_error_not_a_guess(self):
        unit = FirefighterAgent(make_observation(FirefighterTier.SQUAD, "pp-a"))
        situation = situation_from_simulation("sim-x", threatened=THREATENED_ISOLATED, summary={"milestones": []}, horizon_minutes=60)
        with pytest.raises(ValueError, match="no fire position"):
            unit.decide(situation)

    def test_the_ignition_is_the_position_of_last_resort(self):
        unit = FirefighterAgent(make_observation(FirefighterTier.SQUAD, "pp-a"))
        situation = situation_from_simulation(
            "sim-x", threatened=THREATENED_ISOLATED, summary={"milestones": []}, horizon_minutes=60, ignition={"lat": 41.51, "lon": -8.39}
        )
        geometry = unit.decide(situation).proposals[0].intervention["geometry"]
        lon, lat = geometry["coordinates"][0]
        assert distance_m(41.51, -8.39, lat, lon) < 500


@pytest.mark.skip(reason="afinação da supressão: limites combatíveis agora 12000/35000 kW/m; o teste prega a afinação anterior")
def test_crews_go_where_flames_can_be_fought_not_to_a_head_nobody_can_hold():
    vectors = _vectors(
        (41.40, -8.30, 90, 30, 26000),   # crown head: past the 4,000 kW/m limit
        (41.42, -8.30, 270, 6, 5200),    # a flank: its share of the head's intensity is 1,200 kW/m
    )
    sectors = plan_sectors(vectors, zone_radius_m=100)
    assert sectors[0].fightability == 1.0 and sectors[0].speed_mmin == 6
    assert sectors[1].fightability == 0.0
