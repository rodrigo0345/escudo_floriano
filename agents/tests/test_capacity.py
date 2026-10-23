"""Capacity-limited placement: how much line a unit can build, and how the metres are laid out as barriers."""
from __future__ import annotations

import pytest

from firetrace_agents.capacity import line_budget_m
from firetrace_agents.sectors import Sector, assign_units, distance_m, line_segment


class TestBudget:
    def test_people_on_foot_build_at_the_backends_rate(self):
        # backend: Interventions.FireLineRateMPerHourPerPerson = 80 -> 16 people, half an hour
        assert line_budget_m("squad", 16, 30) == pytest.approx(640)

    def test_a_hose_line_goes_down_faster_than_a_hand_line(self):
        assert line_budget_m("truck", 5, 30) > line_budget_m("squad", 5, 30)

    def test_a_helicopter_covers_one_bucket_drop_per_cycle_from_the_rules(self):
        rules = {"aerial": {"helicopter": {"cruiseSpeedKmh": 180, "loadMinutes": 1, "dropMinutes": 1}}}
        assert line_budget_m("helicopter", 3, 30, rules) == pytest.approx(400)  # 5 drops of 80 m
        slower = {"aerial": {"helicopter": {"cruiseSpeedKmh": 90, "loadMinutes": 1, "dropMinutes": 1}}}
        assert line_budget_m("helicopter", 3, 30, slower) < 400

    def test_a_tier_that_builds_no_lines_gets_none_and_nobody_gets_nothing(self):
        assert line_budget_m("police", 4, 30) == 0
        assert line_budget_m("squad", 1, 1) >= 20  # never a useless sliver


class TestBarriers:
    SECTORS = [Sector(41.40 + 0.02 * i, -8.30, 90, 30 - 10 * i, 1600 - 400 * i) for i in range(4)]  # ranked, far apart

    @staticmethod
    def _units(n):
        return [(f"t{i}", "truck") for i in range(n)]

    def test_the_units_of_a_sector_are_laid_end_to_end_without_gaps_or_overlap(self):
        budgets = {f"t{i}": 100.0 for i in range(3)}
        assigned = assign_units(self._units(3), self.SECTORS[:1], [], budgets=budgets, concentration=1)
        offsets = sorted(a.offset_m for a in assigned.values())
        assert offsets == pytest.approx([-100, 0, 100])  # three 100 m pieces centred on the sector
        centres = sorted((a.offset_m for a in assigned.values()))
        assert all(abs((b - a) - 100) < 1e-6 for a, b in zip(centres, centres[1:]))

    def test_the_metres_go_to_the_most_dangerous_sectors_only(self):
        budgets = {f"t{i}": 100.0 for i in range(8)}
        assigned = assign_units(self._units(8), self.SECTORS, [], budgets=budgets, concentration=2)
        used = {a.sector for a in assigned.values()}
        assert used == set(self.SECTORS[:2])

    def test_a_more_dangerous_sector_gets_more_of_the_metres(self):
        budgets = {f"t{i}": 100.0 for i in range(9)}
        assigned = assign_units(self._units(9), self.SECTORS, [], budgets=budgets, concentration=2)
        per_sector = {s: sum(budgets[u] for u, a in assigned.items() if a.sector is s) for s in self.SECTORS[:2]}
        assert per_sector[self.SECTORS[0]] > per_sector[self.SECTORS[1]]

    def test_without_concentration_the_older_placement_is_kept_but_lines_are_limited(self):
        budgets = {f"t{i}": 60.0 for i in range(3)}
        assigned = assign_units(self._units(3), self.SECTORS, [], budgets=budgets)
        assert all(a.segment_m == 60.0 for a in assigned.values())
        assert len({a.sector for a in assigned.values()}) > 1  # still spread over the front

    def test_without_budgets_nothing_changes(self):
        assert all(a.segment_m is None for a in assign_units(self._units(3), self.SECTORS, []).values())

    def test_with_no_sectors_a_unit_still_knows_how_much_it_can_build(self):
        assigned = assign_units(self._units(2), [], [], budgets={"t0": 50.0, "t1": 70.0}, concentration=3)
        assert assigned["t1"].segment_m == 70.0 and assigned["t1"].sector is None


def test_a_line_segment_has_the_requested_length_and_offset():
    line = line_segment(41.4, -8.3, 90, 200, offset_m=300)
    (lon1, lat1), (lon2, lat2) = line["coordinates"]
    assert distance_m(lat1, lon1, lat2, lon2) == pytest.approx(200, rel=0.01)
    mid_lat, mid_lon = (lat1 + lat2) / 2, (lon1 + lon2) / 2
    assert distance_m(41.4, -8.3, mid_lat, mid_lon) == pytest.approx(300, rel=0.02)
