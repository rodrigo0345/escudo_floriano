"""Lives: who is in the fire's way, who can be evacuated in time, and who has to shelter where they are.

The backend does **not** measure this: an evacuation intervention is accepted but changes no number (checked in the code and
by experiment), and ``populationExposed`` only counts people in burned buildings. So the agents keep their own account, with a
simple and explicit model:

* the time the fire needs to arrive comes from the backend's forecast, taking the **pessimistic** quantile (p10), less a safety margin;
* an evacuation needs a mobilisation time, then people leave at a rate set by the responders assigned to the place;
* people who need help to move (care homes, schools, camp sites) leave at a fraction of that rate;
* where the evacuation cannot finish in time, advising people to **shelter in place** beats a late, dangerous evacuation.

Every rate below is an **assumption to calibrate** with the corporations; they live here, in one place.
"""
from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

MOBILIZATION_MIN = 10.0  # alert, notify, start moving
FOOT_PEOPLE_PER_H_PER_RESPONDER = 30.0  # door to door, guiding people on foot
VULNERABLE_RATE_FACTOR = 0.33  # people who need assistance leave about three times slower
TRANSPORT_ROUNDTRIP_MIN = 20.0  # a vehicle's round trip to the shelter and back
ASSUMED_PEOPLE_UNKNOWN_FACILITY = 30  # when neither the facility nor the area statistics say how many people are there
DEFENDERS_PER_ITEM = 2  # fire engines that defend the buildings of one threatened place


@dataclass(frozen=True)
class AtRisk:
    """A place or facility the fire is predicted to reach, with the people in it."""

    id: str
    name: str
    kind: str  # "place" | "facility"
    position: dict[str, float]
    people: int
    vulnerable: bool
    arrival_p10: float  # minutes (forecast clock): the earliest the fire is likely to get there
    arrival_p50: float
    people_source: str  # "forecast" | "area-stats" | "assumed"
    asset: dict[str, Any] = field(default_factory=dict, compare=False)  # the original `ThreatenedAsset`

    @property
    def priority(self) -> tuple[int, float]:
        return (0 if self.vulnerable else 1, self.arrival_p10)  # vulnerable first, then the soonest


@dataclass(frozen=True)
class Evacuator:
    """A unit that can move people out: its throughput in people per minute (before the vulnerable factor)."""

    agent_id: str
    people_per_min: float

    @staticmethod
    def on_foot(agent_id: str, responders: int) -> "Evacuator":
        return Evacuator(agent_id, responders * FOOT_PEOPLE_PER_H_PER_RESPONDER / 60.0)

    @staticmethod
    def by_vehicle(agent_id: str, passengers: int) -> "Evacuator":
        return Evacuator(agent_id, passengers / TRANSPORT_ROUNDTRIP_MIN)


@dataclass(frozen=True)
class LifeDecision:
    item: AtRisk
    action: str  # "evacuate" | "shelter"
    responders: tuple[str, ...]
    completion_min: float | None  # when the evacuation is estimated done (forecast clock); None for shelter
    deadline_min: float  # the latest it can finish: arrival p10 less the safety margin

    @property
    def in_time(self) -> bool:
        return self.action == "evacuate" and self.completion_min is not None and self.completion_min <= self.deadline_min

    @property
    def reason(self) -> str:
        who = f"{self.item.people} pessoas ({self.item.people_source})" + (", vulneráveis" if self.item.vulnerable else "")
        arrival = f"fogo a chegar em ~{self.item.arrival_p10:.0f} min (pessimista; limite {self.deadline_min:.0f} min)"
        if self.action == "evacuate":
            return f"{self.item.name}: {who}; {arrival}. Evacuar com {len(self.responders)} unidade(s): concluída em ~{self.completion_min:.0f} min."
        return f"{self.item.name}: {who}; {arrival}. Não há meios para evacuar a tempo: abrigar no local em vez de uma evacuação tardia e arriscada."


@dataclass(frozen=True)
class LifeReport:
    people_at_risk: int
    evacuated_in_time: int
    sheltered: int
    exposed: int
    vulnerable_at_risk: int
    vulnerable_evacuated: int

    def line(self) -> str:
        return f"risco {self.people_at_risk} · a tempo {self.evacuated_in_time} · abrigo {self.sheltered} · expostas {self.exposed}"


@dataclass(frozen=True)
class LifePlan:
    decisions: tuple[LifeDecision, ...] = ()

    def responders_for(self, item_id: str) -> tuple[str, ...]:
        return next((d.responders for d in self.decisions if d.item.id == item_id), ())

    @property
    def report(self) -> LifeReport:
        at_risk = sum(d.item.people for d in self.decisions)
        in_time = sum(d.item.people for d in self.decisions if d.in_time)
        sheltered = sum(d.item.people for d in self.decisions if d.action == "shelter")
        return LifeReport(
            people_at_risk=at_risk,
            evacuated_in_time=in_time,
            sheltered=sheltered,
            exposed=at_risk - in_time - sheltered,
            vulnerable_at_risk=sum(d.item.people for d in self.decisions if d.item.vulnerable),
            vulnerable_evacuated=sum(d.item.people for d in self.decisions if d.item.vulnerable and d.in_time),
        )


def plan_life(items: Sequence[AtRisk], evacuators: Sequence[Evacuator], *, now: float = 0.0, margin_min: float = 10.0) -> LifePlan:
    """Give each at-risk place the evacuators it needs to finish in time, vulnerable and most urgent first.

    A place that cannot be emptied in time even with every evacuator left is advised to shelter in place, and keeps no
    evacuators (they go to the next place). ``now`` is the decision instant on the forecast's clock.
    """
    free = sorted(evacuators, key=lambda e: -e.people_per_min)
    decisions: list[LifeDecision] = []
    for item in sorted(items, key=lambda i: i.priority):
        factor = VULNERABLE_RATE_FACTOR if item.vulnerable else 1.0
        deadline = item.arrival_p10 - margin_min
        window = deadline - now - MOBILIZATION_MIN
        if item.people <= 0:
            continue
        chosen: list[Evacuator] = []
        rate = 0.0
        if window > 0:
            needed = item.people / window
            for e in free:
                chosen.append(e)
                rate += e.people_per_min * factor
                if rate >= needed:
                    break
        if window > 0 and rate > 0 and rate >= item.people / window:
            for e in chosen:
                free.remove(e)
            done = now + MOBILIZATION_MIN + item.people / rate
            decisions.append(LifeDecision(item, "evacuate", tuple(e.agent_id for e in chosen), done, deadline))
        else:
            decisions.append(LifeDecision(item, "shelter", (), None, deadline))
    return LifePlan(tuple(decisions))
