"""The orchestrator agent: central command for the response operation.

One `plan cycle`:

1. **Builds the team** — reads the available vehicles and personnel pools from the
   API and instantiates one :class:`FirefighterAgent` per combat unit (truck,
   helicopter, squad). The design keeps an :class:`AgentRegistry` so later phases can
   register other agent kinds (police, medical aircraft, civil protection…) without
   touching this firefighter logic — today the force just happens to be all-firefighter.
2. **Collects decisions** — every firefighter agent reports her
   :class:`DecisionMessage` with its reason attached.
3. **Validates what it receives** —
   * tier conformance: rejects (recording an issue) any proposal whose
     ``intervention.type`` the proposing tier cannot execute. This is where the
     "a truck/squad performing an aerial drop" case is structurally rejected;
   * capability gating via ``GET /capabilities``: interventions the server does not
     support *yet* are dropped with a record instead of being submitted and failing;
   * resource conflicts: two actions booking the same vehicle → keep the higher
     priority (life-first) one and drop the other with a recorded issue.
4. **Publishes two plans** — variant ``A`` (life-first sequencing) and variant ``B``
   (suppression-first sequencing) via ``POST /plans``, exactly the two starting
   points for the operator the contract asks an agent to offer. Every action
   carries the firefighter's own reason in ``rationale``, the matching
   ``Intervention`` shape in ``simulationEffects[0]``, and the resources it booked.

The orchestrator can also request a what-if run of a published plan
(``POST /plans/{id}/simulate``) through :meth:`simulate_plan`.
"""
from __future__ import annotations

import copy
import math
import statistics
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable

from .client import ApiProblem, FiretraceClient
from .contracts import UNSAFE_ON_WIRE, validate_against_spec
from .firefighter import ActionProposal, DecisionMessage, FirefighterAgent, Situation, situation_from_simulation
from .buildings import DEFENDERS_PER_ZONE, BuildingZone, building_cells, ignition_minutes, zones_to_defend
from .fuelbreak import plan_strip
from .gnr import CHECKPOINT_PERSONNEL, DEFAULT_NO_EFFECT_KWM, LEAD_MINUTES, GnrPlan, closure_action, control_point_action, intensity_lookup, nearest_units, plan_closures, unit_stub
from .capacity import line_budget_m
from .life import DEFENDERS_PER_ITEM, ASSUMED_PEOPLE_UNKNOWN_FACILITY, AtRisk, Evacuator, LifePlan, plan_life
from .sectors import Assignment, Sector, assign_units, bearing_to, destination, distance_m, plan_sectors, zone_around
from .tiers import ORCHESTRATOR_ONLY, FirefighterTier, can_execute, explain_denial
from .travel import TravelPlanner, centroid


STAGING_DISTANCES_M = (800.0, 1600.0, 3200.0, 6400.0)  # how far from the fire a unit that cannot reach it waits, nearest first


@dataclass
class AgentIssue:
    """Something the orchestrator rejected, and why (audit + tests read these)."""

    agent_id: str
    proposal_title: str
    problem: str


@dataclass
class CycleResult:
    """Audit trail of one full planning cycle."""

    simulation_id: str
    decisions: list[DecisionMessage] = field(default_factory=list)
    issues: list[AgentIssue] = field(default_factory=list)
    plan_a: dict[str, Any] | None = None
    plan_b: dict[str, Any] | None = None
    published: dict[str, str] = field(default_factory=dict)  # variant → plan id
    validation: dict[str, dict[str, Any]] = field(default_factory=dict)  # variant → backend `PlanValidation`
    assignments: dict[str, Assignment] = field(default_factory=dict)  # agent id → sector and place it was given
    life: LifePlan | None = None  # who is in the fire's way, who is evacuated in time, who shelters (None: nobody at risk)
    zones: list[BuildingZone] = field(default_factory=list)  # patches of houses in the fire's way that fire engines were sent to defend
    traffic: GnrPlan | None = None  # the GNR's road closures and control points for this cycle (None: not asked for)
    attack_lead: float | None = None  # minutes until the units are on the fire (median of their routes); None: not computed
    initial_attack: bool = False  # the fire is still weak enough when they arrive: crews go on its outline
    staging: list[dict[str, Any]] = field(default_factory=list)  # ``stage_resources`` actions for the units that cannot reach the fire: they wait as near as is safe
    attack_zones: int = 0  # how many work zones the fire's outline has room for at that minute
    attack_crews: int = 0  # crews put on those zones (the rest are in reserve and block ahead)
    fuel_strips: int = 0  # squads sent to clear a fuel break ahead of the fire (plan A)

    def reasons_log(self) -> list[str]:
        """The reasons every firefighter gave, in reporting order."""
        return [decision.reason for decision in self.decisions]


class AgentRegistry:
    """Who answers the orchestrator's call. New agent kinds plug in here."""

    def __init__(self) -> None:
        self._agents: list[Any] = []

    def register(self, agent: Any) -> None:
        self._agents.append(agent)

    def all(self) -> list[Any]:
        return list(self._agents)

    def __len__(self) -> int:
        return len(self._agents)


class OrchestratorAgent:
    """Central command: collects, validates, sequences, publishes (plans A and B)."""

    KIND = "orchestrator"

    def __init__(self, client: FiretraceClient, *, agent_id: str = "orchestrator") -> None:
        self.client = client
        self.agent_id = agent_id
        self._registry = AgentRegistry()
        self._intervention_support: dict[str, bool] = {}
        self._building_data: dict[str, tuple[dict[str, Any], list[dict[str, Any]]]] = {}  # location → (grid, building points): static, fetched once
        self.lead_quantile = 0.5  # which unit's arrival sets the lead of an initial attack: 0.5 = the median unit, 0.1 = one of the first to get there
        self._routes: dict[Any, Any] = {}  # (unit, target, simulation, instant) → Travel: candidate plans over one forecast ask the same routes
        self._roads: dict[str, dict[str, dict[str, Any]]] = {}  # location → road id → GeoJSON feature: static, fetched once
        self._gnr_org: str | None = None
        self._arrival: dict[str, float] = {}  # unit → minutes it needs to reach the fire (last `_initial_attack`)
        self.arrival_waves = False  # place the units in two waves by arrival time (see `_arrival_waves`); off: one lead for all. Measured: Penha B 4.3 → 3.6 ha, but Falperra A 254 → 301 ha and B 340 → 424 ha

    # -- team --------------------------------------------------------------------
    @property
    def agents(self) -> list[Any]:
        return self._registry.all()

    def pull_fleet(self, *, exclude_tiers: Iterable[FirefighterTier] = ()) -> int:
        """(Re)build the team from what the coordination API reports as available.

        ``exclude_tiers`` leaves whole tiers out (what-if "without helicopters / trucks / squads").
        """
        excluded = frozenset(exclude_tiers)
        self._registry = AgentRegistry()
        for vehicle in self.client.list_vehicles(status="available"):
            agent_id = str(vehicle.get("id") or vehicle.get("callsign") or "").strip()
            if not agent_id:
                continue
            agent = FirefighterAgent.from_vehicle(vehicle, agent_id=agent_id)
            if agent is None or agent.tier in excluded:
                continue  # ambulance, command vehicle, patrol car… — not a combat firefighter unit
            self._registry.register(agent)
        for pool in self.client.list_personnel_pools():
            agent = FirefighterAgent.from_personnel_pool(pool, agent_id=str(pool.get("id") or ""))
            if agent is None or not agent.agent_id or agent.tier in excluded:
                continue
            self._registry.register(agent)
        return len(self._registry)

    # -- cycle -------------------------------------------------------------------
    def run_cycle(
        self,
        simulation_id: str,
        *,
        horizon_minutes: int = 60,
        location_id: str = "guimaraes-concelho",
        title_prefix: str = "Plano de resposta",
        publish: bool = True,
        at_minute: int | None = None,
        stage_minutes: int | None = None,
        concentration: int | None = None,
        life_horizon_minutes: int = 180,
        building_zones: int = 0,
        travel: bool = True,
        traffic: bool = True,
        lean: bool = False,
        fuel_breaks: bool = False,
    ) -> CycleResult:
        """Situation → decisions → validation → plans A and B (→ ``POST /plans``).

        ``at_minute`` is the decision instant (minutes since ignition). Without it the situation is the
        end of the run, which is rarely what a commander decides on.

        ``stage_minutes`` makes the lines as long as each unit can build in that time (see ``capacity.py``); without it
        every unit lays the tier's fixed length. ``concentration`` additionally spends those metres on that many of the most
        dangerous sectors, as one barrier each, instead of spreading the units over the front. ``building_zones`` is how many patches of
        houses (not backend places) the fire engines defend, three engines each; 0 leaves every engine on the fire. ``travel`` asks
        ``POST /routing/route`` how long each unit needs to reach its action (see ``travel.py``): the effect starts then, and a unit
        that cannot get there is not assigned; without it every unit is on site at minute 0, as before. ``traffic`` adds the GNR's road
        closures and traffic-control points (see ``gnr.py``) to both plans. ``lean`` commits only what an initial attack has room for: the
        units left in reserve stay at their stations instead of blocking ahead of the fire (no effect when there is no initial attack).
        ``fuel_breaks`` sends the squads that are not on the fire's outline to clear a strip of fuel ahead of it, where they can finish before it arrives (see ``fuelbreak.py``).
        """
        simulation = self._simulation(simulation_id)
        ignitions = ((simulation or {}).get("scenarioSnapshot") or {}).get("ignitions") or []
        situation = situation_from_simulation(
            simulation_id,
            threatened=self.client.get_threatened(simulation_id, horizon_minutes=max(horizon_minutes, life_horizon_minutes), t_min=at_minute),
            summary=self.client.get_summary(simulation_id),
            horizon_minutes=horizon_minutes,
            at_minute=at_minute,
            rules=self._load_rules(),
            ignition=ignitions[0].get("position") if ignitions else None,
            life_horizon_minutes=life_horizon_minutes,
        )
        if not self.agents:
            self.pull_fleet()
        if not self.agents:
            raise RuntimeError("no firefighter agents available from the fleet")

        result = CycleResult(simulation_id=simulation_id)
        situation, result.attack_lead, result.initial_attack = self._initial_attack(situation, location_id, travel)
        # The engines that defend houses are set aside first: taken out of a barrier already laid they would leave a gap in it.
        result.zones, reserved = self._plan_buildings(situation, location_id, building_zones, stage_minutes, result)
        waves = self._arrival_waves(situation, [a.agent_id for a in self.agents if a.agent_id not in reserved]) if result.initial_attack and self.arrival_waves else []
        if waves:
            everyone = {a.agent_id for a in self.agents}
            result.assignments = {}
            for ids, lead, allowed in waves:  # each wave is placed on the fire where it will be when that wave arrives
                result.assignments.update(self._assign_sectors(situation, simulation, stage_minutes, concentration, exclude=(everyone - ids) | set(reserved), lead=lead if allowed else None))
        else:
            result.assignments = self._assign_sectors(situation, simulation, stage_minutes, concentration, exclude=set(reserved), lead=result.attack_lead if result.initial_attack else None)
        result.life = self._plan_life(situation, location_id, result.assignments, exclude=set(reserved))
        result.assignments.update({agent_id: Assignment(place=asset) for agent_id, asset in reserved.items()})
        if result.initial_attack:
            result.attack_zones, result.attack_crews = self._fit_on_outline(situation, result, waves)
        if fuel_breaks and travel:
            result.fuel_strips = self._fuel_breaks(situation, location_id, result, ((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes"))
        for agent in self.agents:
            assignment = result.assignments.get(agent.agent_id)
            if lean and assignment is not None and assignment.reserve:
                continue  # a lean plan commits only the units the outline has room for; the reserve stays at its stations
            message = agent.decide(situation, assignment)
            result.decisions.append(message)

        guarded = self._guard_decisions(result)
        if travel:
            guarded = self._apply_travel(guarded, situation, location_id, result)
        if traffic:
            result.traffic = self._plan_traffic(
                situation, location_id, result, travel=travel, duration=((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes"),
            )
        plan_a = self._compose_plan(guarded, result, situation, variant="A", location_id=location_id, title_prefix=title_prefix)
        plan_b = self._compose_plan(guarded, result, situation, variant="B", location_id=location_id, title_prefix=title_prefix)
        result.plan_a, result.plan_b = plan_a, plan_b

        self._validate_plans(result)
        if publish:
            for variant, plan in (("A", plan_a), ("B", plan_b)):
                if result.validation.get(variant, {}).get("valid") is False:
                    result.issues.append(AgentIssue("orchestrator", plan["title"], "not published: the backend validation reports errors (see the issues above)."))
                    continue
                published = self.client.create_plan(plan)
                result.published[variant] = published.get("id", "")
        return result

    def _simulation(self, simulation_id: str) -> dict[str, Any] | None:
        try:
            return self.client.get_simulation(simulation_id)
        except ApiProblem:
            return None

    def _initial_attack(self, situation: Situation, location_id: str, travel: bool) -> tuple[Situation, float | None, bool]:
        """Can the units still fight the fire head-on when they get there? If so the crews go on its outline.

        The backend weakens direct attack with the fire's intensity (to nothing from ``noEffectFromKwm``), and a unit needs minutes to arrive:
        the median of the units' routes to the fire is the lead. If the fire is still below that intensity at that minute the situation is
        marked ``initial_attack``: crews attack the fire where it will be on arrival and work as long as a crew can (the rules' maximum).
        Otherwise the fire will have outgrown direct attack and the units block it ahead instead, as before.
        """
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        lead: float | None = 0.0
        self._arrival = {}
        if travel:
            try:
                target = situation.anchor
            except ValueError:  # no fire position at all: nothing to attack yet
                return situation, None, False
            # the drive alone, without the predicted fire: the target is the fire, and every road to it "burns" before anyone could arrive
            planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=False)
            self._arrival = {a.agent_id: float(r.eta_minutes) for a in self.agents if a.tier is not FirefighterTier.HELICOPTER and (r := planner.eta(a, target)).reachable and r.eta_minutes is not None}
            etas = list(self._arrival.values())
            lead = float(statistics.quantiles(etas, n=100, method="inclusive")[max(0, min(98, round(self.lead_quantile * 100) - 1))]) if len(etas) > 1 else (float(etas[0]) if etas else None)
        if lead is None:
            return situation, None, False
        lead = min(lead, float(situation.horizon_minutes))
        rules = situation.rules or {}
        limit = float(((rules.get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)
        # the units do not arrive together (see `_arrival_waves`): the attack is on if the first of them can still work when it gets there
        first = [e for e in self._arrival.values() if e <= lead] if self.arrival_waves else []
        first_lead = min(float(statistics.median(first)), lead) if first else lead
        if intensity_lookup(situation.summary)(decided_at + first_lead) >= limit:
            return situation, lead, False
        work = int(((rules.get("crews") or {}).get("maxContinuousWorkMinutes")) or 240)
        return replace(situation, initial_attack=True, work_minutes=work), lead, True

    def _fuel_breaks(self, situation: Situation, location_id: str, result: CycleResult, duration: int | None) -> int:
        """Squads that are not on the fire's outline clear a strip of fuel ahead of it, when they can finish before it gets there. Returns how many."""
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=True)
        seen: dict[int, dict[str, Any]] = {}

        def perimeters_at(minute: int) -> dict[str, Any]:
            minute = max(0, min(int(round(minute / 5.0)) * 5, int(duration) if duration else minute))
            if minute not in seen:
                try:
                    seen[minute] = self.client.get_perimeters(situation.simulation_id, t_min=minute)
                except ApiProblem:
                    seen[minute] = {}
            return seen[minute]

        count = 0
        for agent in self.agents:
            assignment = result.assignments.get(agent.agent_id)
            if agent.tier is not FirefighterTier.SQUAD or assignment is None or assignment.sector is None or assignment.place is not None:
                continue
            if situation.initial_attack and not assignment.reserve:
                continue  # on the outline: it attacks the fire where it is
            strip = plan_strip(assignment.sector, agent.observation.crew_onboard, decided_at, travel=lambda point, a=agent: planner.eta(a, point), perimeters_at=perimeters_at)
            if strip is not None:
                result.assignments[agent.agent_id] = replace(assignment, fuel_strip=strip)
                count += 1
        return count

    def _arrival_waves(self, situation: Situation, unit_ids: list[str]) -> list[tuple[set[str], float, bool]]:
        """Split the units by when they reach the fire: (units, minutes until they are there, whether they can still fight it head-on then).

        The fire grows while the slower units drive: a crew that arrives at minute 15 and one that arrives at minute 55 do not stand on the same
        outline, nor can the second fight a fire that has gone past the intensity direct attack stops working at. Two waves, the units that get
        there before the median and the rest, each placed on the fire at its own median arrival; the rest of the units (aircraft, no route time)
        go with the first. A wave that arrives too late for direct attack is returned with ``False``: its crews block ahead of the fire instead.
        """
        etas = {i: self._arrival[i] for i in unit_ids if i in self._arrival}
        if len(etas) < 4:
            return []
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        limit = float((((situation.rules or {}).get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)
        intensity_at = intensity_lookup(situation.summary)
        split = float(statistics.median(etas.values()))
        early = {i for i, e in etas.items() if e <= split}
        late = set(etas) - early
        waves: list[tuple[set[str], float, bool]] = []
        for index, members in enumerate((early, late)):
            if not members:
                continue
            lead = min(float(statistics.median(etas[i] for i in members)), float(situation.horizon_minutes))
            ids = set(members) | (set(unit_ids) - set(etas) if index == 0 else set())
            waves.append((ids, lead, intensity_at(decided_at + lead) < limit))
        return waves

    def _fit_on_outline(self, situation: Situation, result: CycleResult, waves: list[tuple[set[str], float, bool]] | None = None) -> tuple[int, int]:
        """Put the crews on the fire's outline, as many as it has room for, and no more than the rules let one piece of ground use.

        The backend multiplies the effect of every crew on the same ground without limit, but its own rules cap what a crew can do at
        ``maxEffectiveness``: a planner should not count on more than that from one zone. So crews fill a zone until together they reach
        that cap, then the next zone along the outline; the outline has ``perimeter / (2 × zone radius)`` zones. Crews left over are in
        reserve (``Assignment.reserve``): they block ahead of the fire as they would without an initial attack.
        Returns (zones available, crews put on them).
        """
        rules = situation.rules or {}
        cap = float(((rules.get("suppression") or {}).get("maxEffectiveness")) or 0.85)
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        total_zones = on_outline = 0
        for ids, lead, allowed in waves or [(None, result.attack_lead or 0.0, True)]:
            crews = [
                a for a in self.agents
                if a.tier is not FirefighterTier.HELICOPTER and a.agent_id in result.assignments and result.assignments[a.agent_id].place is None and (ids is None or a.agent_id in ids)
            ]
            if not allowed:  # this wave gets there after direct attack stopped working: it blocks ahead of the fire
                for agent in crews:
                    result.assignments[agent.agent_id] = replace(result.assignments[agent.agent_id], reserve=True)
                continue
            zones = self._outline_zones(situation, int(round(decided_at + lead)))
            total_zones += zones
            by_sector: dict[Any, list[FirefighterAgent]] = {}
            for agent in sorted(crews, key=lambda a: (a.tier is not FirefighterTier.TRUCK, a.agent_id)):  # engines first: they bring the water
                by_sector.setdefault(result.assignments[agent.agent_id].sector, []).append(agent)
            per_sector = max(1, math.ceil(zones / max(len(by_sector), 1)))
            for sector_crews in by_sector.values():
                zone, survive = 0, 1.0
                for agent in sector_crews:
                    if 1.0 - survive >= cap:  # this zone is as strong as the rules allow: next one along the outline
                        zone, survive = zone + 1, 1.0
                    if zone >= per_sector:
                        result.assignments[agent.agent_id] = replace(result.assignments[agent.agent_id], reserve=True)
                        continue
                    survive *= 1.0 - situation.suppression_effectiveness(agent.observation.crew_onboard, agent.observation.water_capacity_l)
                    result.assignments[agent.agent_id] = replace(result.assignments[agent.agent_id], slot=zone, reserve=False)
                    on_outline += 1
        return total_zones, on_outline

    def _outline_zones(self, situation: Situation, minute: int) -> int:
        """How many work zones the fire's outline at ``minute`` has room for (its length over the width of a zone); at least one."""
        try:
            features = self.client.get_perimeters(situation.simulation_id, t_min=max(minute, 0)).get("features") or []
        except ApiProblem:
            return 1
        length = 0.0
        for feature in features:
            geometry = feature.get("geometry") or {}
            rings = geometry.get("coordinates") or []
            outer = [poly[0] for poly in rings] if geometry.get("type") == "MultiPolygon" else rings[:1]
            for ring in outer:
                length += sum(distance_m(a[1], a[0], b[1], b[0]) for a, b in zip(ring, ring[1:]))
        return max(1, math.ceil(length / (2.0 * situation.zone_radius_m)))

    def _assign_sectors(
        self, situation: Situation, simulation: dict[str, Any] | None, stage_minutes: int | None = None, concentration: int | None = None,
        exclude: set[str] = frozenset(),  # type: ignore[assignment]
        lead: float | None = None,
    ) -> dict[str, Assignment]:
        """Spread the units over the fire front instead of letting each one aim at the head.

        The front comes from the backend's spread vectors one horizon ahead of the decision (where the fire will be
        when the units are working), falling back to the decision instant itself; in an initial attack it is the front
        at the minute the units arrive (``lead``). Threatened places are dealt out too.
        """
        decided_at = situation.at_minute
        if decided_at is None:
            decided_at = int(situation.latest_milestone.get("tMin") or 0)
        duration = ((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes")
        ahead = decided_at + (round(lead) if lead is not None else situation.horizon_minutes)
        instants = [min(ahead, duration) if duration else ahead, decided_at]
        sectors: list[Sector] = []
        for t_min in dict.fromkeys(instants):
            try:
                vectors = self.client.get_vectors(situation.simulation_id, t_min=int(t_min))
            except ApiProblem:  # a server without vectors: units fall back to the fire's head
                continue
            sectors = plan_sectors(vectors, zone_radius_m=situation.zone_radius_m)
            if sectors:
                break
        fighters = [agent for agent in self.agents if agent.agent_id not in exclude]
        units = [(agent.agent_id, agent.tier.value) for agent in fighters]
        budgets = (
            {a.agent_id: line_budget_m(a.tier.value, a.observation.crew_onboard, stage_minutes, situation.rules) for a in fighters}
            if stage_minutes
            else None
        )
        # places are not dealt out here: the life planner decides who looks after whom (see `_plan_life`)
        return assign_units(units, sectors, [], budgets=budgets, concentration=concentration)

    def _people_at(self, asset: dict[str, Any], location_id: str) -> tuple[int, str]:
        """How many people are there: the forecast says it for places; for a facility without a count, the area statistics, else an assumption."""
        if asset.get("population"):
            return int(asset["population"]), "forecast"
        position = asset.get("position")
        if position:
            try:
                ring = zone_around(float(position["lat"]), float(position["lon"]), 0.0, 200.0, 0, 12)
                stats = self.client.get_area_stats(location_id, ring)
                counted = int(stats.get("estimatedPeople") or 0) + sum(int(f.get("capacity") or 0) for f in stats.get("facilities") or [])
                if counted > 0:
                    return counted, "area-stats"
            except ApiProblem:
                pass
        return ASSUMED_PEOPLE_UNKNOWN_FACILITY, "assumed"

    def _plan_life(self, situation: Situation, location_id: str, assignments: dict[str, Assignment], exclude: set[str] = frozenset()) -> LifePlan | None:  # type: ignore[assignment]
        """Decide who evacuates what (vulnerable and most urgent first) and who shelters; hands each place its units.

        Squads (and vehicles that carry passengers) evacuate; fire engines able to defend buildings defend the threatened places.
        Everyone else keeps fighting the fire.
        """
        from dataclasses import replace  # local: only this method rewrites assignments

        assets = situation.people_in_danger_within(situation.life_horizon_minutes)
        if not assets:
            return None
        now = float(situation.at_minute or 0)
        items = []
        for asset in assets:
            people, source = self._people_at(asset, location_id)
            arrival = asset["arrivalMinute"]
            items.append(AtRisk(
                id=str(asset["id"]), name=str(asset.get("name") or asset["id"]), kind=str(asset.get("assetType") or "place"), position=asset.get("position") or {},
                people=people, vulnerable=bool(asset.get("vulnerable")), arrival_p10=float(arrival.get("p10", arrival["p50"])), arrival_p50=float(arrival["p50"]),
                people_source=source, asset=asset,
            ))
        evacuators = []
        for agent in (a for a in self.agents if a.agent_id not in exclude):
            obs = agent.observation
            if agent.tier.value == "squad":
                evacuators.append(Evacuator.on_foot(agent.agent_id, obs.crew_onboard))
            elif obs.passenger_capacity > 0 and obs.capabilities & {"evacuation_transport", "traffic_control", "perimeter_security"}:
                evacuators.append(Evacuator.by_vehicle(agent.agent_id, obs.passenger_capacity))
        margin = float((((situation.rules or {}).get("safety") or {}).get("withdrawWhenFireArrivesInMinutes")) or 10.0)
        plan = plan_life(items, evacuators, now=now, margin_min=margin)
        by_id = {d.item.id: d for d in plan.decisions}
        for decision in plan.decisions:
            for agent_id in decision.responders:
                if agent_id in assignments:
                    assignments[agent_id] = replace(assignments[agent_id], place=decision.item.asset)
        defenders = [a for a in self.agents if a.tier.value == "truck" and "structure_protection" in a.observation.capabilities and a.agent_id not in exclude and a.agent_id not in {r for d in plan.decisions for r in d.responders}]
        for decision in sorted(plan.decisions, key=lambda d: d.item.priority):
            for agent in defenders[:DEFENDERS_PER_ITEM]:
                if agent.agent_id in assignments:
                    assignments[agent.agent_id] = replace(assignments[agent.agent_id], place=decision.item.asset)
            defenders = defenders[DEFENDERS_PER_ITEM:]
        return plan if by_id else None

    def _plan_buildings(
        self, situation: Situation, location_id: str, max_zones: int, stage_minutes: int | None, result: CycleResult
    ) -> tuple[list[BuildingZone], dict[str, dict[str, Any]]]:
        """Pick the houses the forecast fire reaches soonest and set aside three fire engines for each patch of them.

        ``/threatened`` only names places, so the houses come from ``/locations/{id}/buildings`` and the arrival of the fire from the
        forecast's own ignition grid. Returns the zones, most houses first, and ``{engine id: its zone}``. The engines are taken from
        the end of the fleet list: the life planner takes its defenders from the front.
        """
        if max_zones <= 0:
            return [], {}
        engines = [a for a in self.agents if a.tier.value == "truck" and "structure_protection" in a.observation.capabilities][::-1]
        if not engines:
            return [], {}
        try:
            if location_id not in self._building_data:
                self._building_data[location_id] = (self.client.get_location(location_id)["grid"], self.client.list_buildings(location_id))
            grid, features = self._building_data[location_id]
            ignition = ignition_minutes(self.client.get_ignition_grid(situation.simulation_id))
        except ApiProblem as error:  # no buildings or no grid: the engines keep fighting
            result.issues.append(AgentIssue("orchestrator", "building zones", f"not planned [{error.code}]: {error}"))
            return [], {}
        decided_at = situation.at_minute if situation.at_minute is not None else int(situation.latest_milestone.get("tMin") or 0)
        cells = building_cells(grid, features)
        zones = zones_to_defend(
            cells, ignition, after_min=decided_at, until_min=decided_at + (stage_minutes or situation.horizon_minutes), radius_m=situation.zone_radius_m,
            max_zones=min(max_zones, max(1, len(engines) // DEFENDERS_PER_ZONE)),
        )
        reserved: dict[str, dict[str, Any]] = {}
        for index, zone in enumerate(zones):
            for agent in engines[index * DEFENDERS_PER_ZONE:(index + 1) * DEFENDERS_PER_ZONE]:
                reserved[agent.agent_id] = zone.asset(index)
        return zones, reserved

    def _command_organization(self) -> str:
        """The organization that issues advisories to the public: civil protection if the backend has one, else the first unit's."""
        if getattr(self, "_command_org", None):
            return self._command_org
        try:
            orgs = self.client.list_organizations("civil_protection")
        except ApiProblem:
            orgs = []
        self._command_org = str(orgs[0]["id"]) if orgs else (_organization_of_agent(self.agents[0]) if self.agents else "org-unknown")
        return self._command_org

    def _shelter_actions(self, result: "CycleResult") -> list[dict[str, Any]]:
        """`shelter_in_place` actions for the places the planner could not evacuate in time."""
        actions = []
        for decision in (result.life.decisions if result.life else ()):
            if decision.action != "shelter":
                continue
            item = decision.item
            if not item.position:
                continue
            actions.append({
                "id": f"shelter-{item.id}", "type": "shelter_in_place", "title": f"Abrigar no local: {item.name}",
                "organizationId": self._command_organization(), "priority": "critical", "rationale": decision.reason,
                "area": zone_around(float(item.position["lat"]), float(item.position["lon"]), 0.0, 250.0, 0, 16),
                "placeIds": [item.id], "guidance": "Ficar em casa, janelas e portas fechadas, afastado das fachadas viradas ao fogo; seguir as indicações da Proteção Civil.",
                "durationMinutes": 90,
            })
        return actions

    def _load_rules(self) -> dict[str, Any] | None:
        """The backend's own numbers (`GET /rules`); a server without them leaves the agents on their defaults."""
        try:
            return self.client.get_rules()
        except ApiProblem:
            return None

    def _validate_plans(self, result: CycleResult) -> None:
        """`POST /plans/validate` each plan before publishing; every issue keeps the backend's stable ``code``."""
        for variant, plan in (("A", result.plan_a), ("B", result.plan_b)):
            try:
                validation = self.client.validate_plan(plan)
            except ApiProblem as error:  # e.g. a server without the validator: report, do not block
                result.issues.append(AgentIssue("orchestrator", plan["title"], f"validation unavailable [{error.code}]: {error}"))
                continue
            result.validation[variant] = validation
            for issue in validation.get("issues", []):
                result.issues.append(
                    AgentIssue(
                        agent_id=issue.get("actionId") or issue.get("resourceId") or "plan",
                        proposal_title=f"plan {variant}",
                        problem=f"{issue.get('severity')} {issue.get('code')}: {issue.get('message')}",
                    )
                )

    def simulate_plan(self, plan_id: str, *, baseline_simulation_id: str | None = None) -> dict[str, Any]:
        """Ask the contract's what-if: ``POST /plans/{id}/simulate`` and await outcome."""
        simulation = self.client.simulate_plan(plan_id, baseline_simulation_id=baseline_simulation_id, wait_seconds=None)
        return self.client.wait_for_simulation(simulation["id"])

    # -- validation --------------------------------------------------------------
    def _load_intervention_support(self) -> None:
        try:
            caps = self.client.get_capabilities()
        except Exception:  # noqa: BLE001 — a server without /capabilities yet: assume all
            self._intervention_support = {}
            return
        items = {}
        for group in ("interventions", "actionTypes"):
            for item in caps.get(group) or []:
                items[item.get("name")] = bool(item.get("supported"))
        self._intervention_support = items

    def _supported(self, name: str) -> bool:
        if not self._intervention_support or name not in self._intervention_support:
            return True  # absent from the list → treat as supported, contract-first
        return self._intervention_support[name]

    def _guard_decisions(self, result: CycleResult) -> dict[str, list[tuple[DecisionMessage, ActionProposal]]]:
        self._load_intervention_support()
        kept: dict[str, list[tuple[DecisionMessage, ActionProposal]]] = {}
        for message in result.decisions:
            survivors: list[tuple[DecisionMessage, ActionProposal]] = []
            for proposal in message.proposals:
                issue = self._proposal_issue(message, proposal)
                if issue is not None:
                    result.issues.append(issue)
                    continue
                survivors.append((message, proposal))
            kept[message.agent_id] = survivors
        return self._resolve_resource_conflicts(kept, result)

    def _proposal_issue(self, message: DecisionMessage, proposal: ActionProposal) -> AgentIssue | None:
        kind = proposal.intervention.get("type")
        if kind in UNSAFE_ON_WIRE:
            return AgentIssue(
                agent_id=message.agent_id,
                proposal_title=proposal.title,
                problem=f"dropped: {kind!r} is listed by the spec but the live backend rejects its payload (spec and backend disagree).",
            )
        if kind in ORCHESTRATOR_ONLY:
            return AgentIssue(
                agent_id=message.agent_id,
                proposal_title=proposal.title,
                problem=(
                    f"rejection: {kind} is a command-level intervention; agent "
                    f"{message.agent_id} (tier {message.tier.value}) cannot execute it."
                ),
            )
        if not can_execute(message.tier, kind):
            return AgentIssue(
                agent_id=message.agent_id,
                proposal_title=proposal.title,
                problem=f"rejected: {explain_denial(message.tier, kind)}.",
            )
        if not self._supported(kind):
            return AgentIssue(
                agent_id=message.agent_id,
                proposal_title=proposal.title,
                problem=f"dropped: capability {kind!r} not currently supported by the server.",
            )
        return None

    def _resolve_resource_conflicts(
        self,
        kept: dict[str, list[tuple[DecisionMessage, ActionProposal]]],
        result: CycleResult,
    ) -> dict[str, list[tuple[DecisionMessage, ActionProposal]]]:
        """same vehicle twice → keep the higher-priority (life) proposal, drop the other."""
        claimed: dict[str, tuple[str, str]] = {}  # vehicleId → (agentId, actionTitle)
        for agent_id, pairs in kept.items():
            survivors: list[tuple[DecisionMessage, ActionProposal]] = []
            for message, proposal in pairs:
                collision_owner = None
                for resource in proposal.resources:
                    if resource.get("resourceType") == "vehicle":
                        vehicle_id = resource.get("resourceId")
                        owner = claimed.get(vehicle_id)
                        if owner and owner[0] != agent_id:
                            collision_owner = owner[0]
                            break
                if collision_owner is not None:
                    result.issues.append(
                        AgentIssue(
                            agent_id=agent_id,
                            proposal_title=proposal.title,
                            problem=(
                                f"resource_conflict: same vehicle already proposed by {collision_owner}; "
                                f"kept that one (life objectives first), dropped {proposal.title!r}."
                            ),
                        )
                    )
                    continue
                for resource in proposal.resources:
                    if resource.get("resourceType") == "vehicle":
                        claimed[resource.get("resourceId")] = (agent_id, proposal.title)
                survivors.append((message, proposal))
            kept[agent_id] = survivors
        return kept

    def _gnr_organization(self) -> str:
        if self._gnr_org is None:
            try:
                found = self.client.list_organizations("gnr")
            except ApiProblem:
                found = []
            self._gnr_org = str(found[0]["id"]) if found else "org-gnr"
        return self._gnr_org

    def _plan_traffic(self, situation: Situation, location_id: str, result: CycleResult, *, travel: bool, duration: int | None = None) -> GnrPlan:
        """The GNR's part: close every road the fire cuts until the end of the simulation, and a patrol at each end (see ``gnr.py``).

        Not only the next hour: a road is closed *before* the fire reaches it (the action's trigger is its predicted cut minus a lead), so the
        plan has to name them all. The most urgent get the patrols, which are few.
        """
        plan = GnrPlan()
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        try:
            statuses = self.client.get_road_status(situation.simulation_id, t_min=int(decided_at))
            if location_id not in self._roads:
                self._roads[location_id] = {str(f["properties"]["id"]): f for f in self.client.list_roads(location_id)}
            organization = self._gnr_organization()
            units = [v for v in self.client.list_vehicles(capability="traffic_control", status="available") if v.get("organizationId") == organization]
        except ApiProblem as error:  # no road status or no roads: the plans simply have no traffic actions
            result.issues.append(AgentIssue("gnr", "road closures", f"not planned [{error.code}]: {error}"))
            return plan
        no_effect = float(((situation.rules or {}).get("suppression") or {}).get("noEffectFromKwm") or DEFAULT_NO_EFFECT_KWM)
        horizon = max(float(duration) - decided_at, float(situation.horizon_minutes)) if duration else float(situation.life_horizon_minutes)
        plan.closures = plan_closures(
            statuses, self._roads[location_id], decided_at=decided_at, horizon=horizon, intensity_at=intensity_lookup(situation.summary), no_effect_kwm=no_effect,
        )
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes)
        stations = {u["stationId"]: planner.station_position(u["stationId"]) for u in units if u.get("stationId")}
        stations = {sid: pos for sid, pos in stations.items() if pos}
        taken: set[str] = set()
        for index, closure in enumerate(plan.closures):
            checkpoints: list[dict[str, Any]] = []
            points: list[dict[str, Any]] = []
            for end_index, end in enumerate(closure.ends):
                chosen: tuple[dict[str, Any], Any] | None = None
                late = False
                # a patrol is worth sending only if it is there before the fire cuts the road (or, if the fire has cut it, while it stays cut)
                deadline = (closure.reopen_p50 - decided_at - LEAD_MINUTES) if closure.already_cut(decided_at) else (closure.cut_p10 - decided_at)
                for vehicle in nearest_units(units, stations, end, taken):
                    route = planner.eta(unit_stub(vehicle), end) if travel else None
                    if route is not None and not route.reachable:
                        continue
                    if route is not None and route.eta_minutes is not None and route.eta_minutes > deadline:
                        late = True
                        continue
                    chosen = (vehicle, route)
                    break
                if chosen is None:
                    plan.issues.append(f"{closure.name}: {'no GNR unit gets to' if late else 'no GNR unit can reach'} end {end_index + 1} in time")
                    continue
                vehicle, route = chosen
                taken.add(str(vehicle["id"]))
                resource: dict[str, Any] = {"resourceType": "vehicle", "resourceId": vehicle["id"], "personnel": int(vehicle.get("crewCapacity") or CHECKPOINT_PERSONNEL), "responsibility": "traffic_control"}
                if route is not None and route.eta_minutes is not None:
                    resource["etaMinutes"] = round(route.eta_minutes, 1)
                    resource["fromStationId"] = route.from_station
                checkpoints.append({"position": end, "label": f"{closure.name} · ponta {end_index + 1}", "organizationId": organization, "personnel": resource["personnel"], "vehicles": 1})
                points.append(control_point_action(closure, index, end_index, organization, decided_at, resource))
            plan.actions.append(closure_action(closure, index, organization, decided_at, checkpoints))
            plan.actions.extend(points)
        for message in plan.issues:
            result.issues.append(AgentIssue("gnr", "traffic control", message))
        return plan

    def _apply_travel(
        self,
        kept: dict[str, list[tuple[DecisionMessage, ActionProposal]]],
        situation: Situation,
        location_id: str,
        result: CycleResult,
    ) -> dict[str, list[tuple[DecisionMessage, ActionProposal]]]:
        """Give every proposal the time its unit needs to get there; drop what the unit cannot reach (and what waits for it)."""
        # In an initial attack the target is the fire itself: every road to it "burns" before anyone arrives, so the drive is timed without the
        # predicted fire (the crews come in from the unburned side; the intensity gate in `_initial_attack` already checked they can still work).
        planner = TravelPlanner(
            self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=not situation.initial_attack,
        )
        agents = {agent.agent_id: agent for agent in self.agents}
        lost: dict[str, tuple[FirefighterAgent, str, dict[str, Any]]] = {}  # unit → why it cannot reach its target, and the target
        for agent_id, pairs in kept.items():
            agent = agents.get(agent_id)
            if agent is None:
                continue
            dropped: set[str] = set()
            survivors: list[tuple[DecisionMessage, ActionProposal]] = []
            told = False
            for message, proposal in pairs:
                if (proposal.trigger and proposal.trigger.get("actionId") in dropped) or any(d in dropped for d in proposal.depends_on):
                    result.issues.append(AgentIssue(agent_id, proposal.title, "dropped: it waits for an action this unit cannot reach."))
                    dropped.add(proposal.proposal_id)
                    continue
                target = proposal.target or centroid(proposal.intervention.get("geometry"))
                if target is None:
                    survivors.append((message, proposal))
                    continue
                route = planner.eta(agent, target)
                if not route.reachable:
                    result.issues.append(AgentIssue(agent_id, proposal.title, f"dropped: the unit cannot get there ({route.reason})."))
                    dropped.add(proposal.proposal_id)
                    lost.setdefault(agent_id, (agent, route.reason, target))
                    continue
                proposal.eta_minutes, proposal.from_station, proposal.route = route.eta_minutes, route.from_station, route.geometry
                if route.eta_minutes is not None and not told:
                    message.reason += f" Viagem: {route.describe()} (encaminhamento do servidor, sem fogo previsto nem cortes pelo caminho)."
                    told = True
                deadline = (proposal.intervention.get("completeBy") or {}).get("offsetMinutes") if proposal.intervention.get("type") == "evacuation" else None
                if deadline is not None and route.eta_minutes is not None and route.eta_minutes > float(deadline):
                    result.issues.append(AgentIssue(agent_id, proposal.title, f"late: the unit arrives in ~{route.eta_minutes:.0f} min, after the evacuation deadline ({deadline} min)."))
                survivors.append((message, proposal))
            kept[agent_id] = survivors
        if planner.unavailable:
            result.issues.append(AgentIssue("orchestrator", "travel times", "routing unavailable: the plans carry no arrival times."))
        # only a unit left with nothing to do waits at a staging point: one that kept another action is already in the plan
        result.staging = self._stage({k: v for k, v in lost.items() if not kept.get(k)}, situation, location_id, result)
        return kept

    def _stage(self, lost: dict[str, tuple[FirefighterAgent, str, dict[str, Any]]], situation: Situation, location_id: str, result: CycleResult) -> list[dict[str, Any]]:
        """Units that cannot reach the fire do not vanish: they go as near as is safe and wait there (a ``stage_resources`` action per organization).

        The point is on the line from the fire to the unit's station, as near to the fire as the routing says the unit can get while avoiding the predicted
        fire (800 m, then 1.6, 3.2 and 6.4 km out). The unit does nothing there: the plan says so, and why.
        """
        if not lost:
            return []
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=True)
        by_org: dict[str, list[tuple[FirefighterAgent, str, dict[str, Any]]]] = {}
        for agent, reason, target in lost.values():
            by_org.setdefault(agent.observation.organization_id, []).append((agent, reason, target))
        actions: list[dict[str, Any]] = []
        for index, (organization, group) in enumerate(sorted(by_org.items())):
            first, _reason, anchor = group[0]
            base = planner.station_position(first.observation.station_id) if first.observation.station_id else None
            if base is None:
                continue
            heading = bearing_to(float(anchor["lat"]), float(anchor["lon"]), base["lat"], base["lon"])
            away = distance_m(float(anchor["lat"]), float(anchor["lon"]), base["lat"], base["lon"])
            spot = next(
                (
                    {"lat": lat, "lon": lon}
                    for d in STAGING_DISTANCES_M
                    for lat, lon in [destination(float(anchor["lat"]), float(anchor["lon"]), heading, min(d, away))]
                    if planner.eta(first, {"lat": lat, "lon": lon}).reachable
                ),
                None,
            )
            if spot is None:
                result.issues.append(AgentIssue("orchestrator", "staging", f"no safe waiting point found for {len(group)} unit(s) of {organization}."))
                continue
            resources: list[dict[str, Any]] = []
            for agent, _r, _t in group:
                travel = planner.eta(agent, spot)
                if not travel.reachable or travel.eta_minutes is None:
                    continue
                resource: dict[str, Any] = {"resourceType": "vehicle" if agent.observation.vehicle_id else "personnel_pool", "resourceId": agent.observation.vehicle_id or agent.agent_id,
                                            "personnel": agent.observation.crew_onboard, "responsibility": "standby", "etaMinutes": round(travel.eta_minutes, 1)}
                if travel.from_station:
                    resource["fromStationId"] = travel.from_station
                if resource["resourceType"] == "personnel_pool" and travel.geometry:
                    resource["route"] = travel.geometry
                resources.append(resource)
            if not resources:
                continue
            reasons = sorted({reason.split("(")[-1].rstrip(") ") for _a, reason, _t in group})
            actions.append({
                "id": f"stage-{index}",
                "type": "stage_resources",
                "title": f"Pré-posicionar {len(resources)} meios a {distance_m(float(anchor['lat']), float(anchor['lon']), spot['lat'], spot['lon']) / 1000:.1f} km do fogo",
                "organizationId": organization,
                "priority": "high",
                "rationale": f"Estas unidades não chegam ao fogo ({', '.join(reasons)}): vão até ao ponto mais próximo a que chegam com segurança e esperam aí, prontas a avançar.",
                "stagingArea": {"position": spot, "label": "Ponto de espera"},
                "readiness": "engine_running",
                "resources": resources,
            })
        return actions

    # -- plan composition -----------------------------------------------------------
    def _compose_plan(
        self,
        proposals_by_agent: dict[str, list[tuple[DecisionMessage, ActionProposal]]],
        result: CycleResult,
        situation: Situation,
        *,
        variant: str,
        location_id: str,
        title_prefix: str,
    ) -> dict[str, Any]:
        ordered = _sequenced(proposals_by_agent, life_first=(variant == "A"))
        life_first = variant == "A"
        by_id = {proposal.proposal_id: proposal for _message, proposal in ordered}
        parallel: set[int] = set()  # plan B: proposals that no longer wait for a life action
        if not life_first:
            ordered, parallel = _area_first(ordered)
        actions: list[dict[str, Any]] = []
        strategy = (
            "Evacuar imediatamente quem está no caminho e atacar o fogo em sequência."
            if life_first
            else "Atacar o fogo desde o início na cabeça/flancos; evacuações arrancam em paralelo."
        )
        summary = ["### Decideu cada agente (razão comunicada ao orchestrador)", ""]
        issues_lines = [
            f"- {issue.agent_id}: {issue.proposal_title}: {issue.problem}" for issue in result.issues
        ]
        for message, proposal in ordered:
            action: dict[str, Any] = {}
            action_id = proposal.proposal_id or f"{variant.lower()}-{len(actions) + 1:02d}"
            organization = message.agent_id and _organization_of(message)
            action.update(
                {
                    "id": action_id,
                    "type": proposal.action_type,
                    "title": proposal.title,
                    "organizationId": organization,
                    "priority": proposal.priority,
                    "rationale": message.reason,  # the firefighter's reason, verbatim
                    "expectedEffect": proposal.expected_effect or "",
                    "confidence": min(0.99, proposal.confidence),
                }
            )
            if proposal.resources:
                action["resources"] = proposal.resources
                if proposal.eta_minutes is not None:  # the backend's own routing said how long each unit needs to be there
                    action["resources"] = [
                        {
                            **r,
                            "etaMinutes": round(proposal.eta_minutes, 1),
                            **({"fromStationId": proposal.from_station} if proposal.from_station else {}),
                            # the backend routes vehicles itself; a crew on foot has no vehicle to route, so it carries the road the routing gave it
                            **({"route": proposal.route} if r.get("resourceType") == "personnel_pool" and proposal.route else {}),
                        }
                        for r in proposal.resources
                    ]
            waits = id(proposal) not in parallel
            if proposal.depends_on and waits:
                action["dependsOn"] = list(proposal.depends_on)
            if proposal.trigger and waits:
                action["trigger"] = proposal.trigger
            if proposal.safety_notes:
                action["safetyNotes"] = proposal.safety_notes
            intervention = {k: v for k, v in proposal.intervention.items() if v is not None}
            if life_first and proposal.trigger and proposal.trigger.get("kind") == "on_action_complete":
                # The backend ignores `trigger`/`dependsOn` when it simulates a plan: it only reads each effect's own
                # `start`. So "attack after the evacuation" has to be written into the effect's start time too.
                intervention["start"] = {"offsetMinutes": _follow_up_delay(by_id.get(proposal.trigger.get("actionId")))}
            if proposal.eta_minutes is not None and isinstance(intervention.get("start"), dict):
                # nothing works before the unit is there: the backend applies the effect from its `start`, and a missing ETA would put crews on the fire at once
                begin = intervention["start"].get("offsetMinutes") or 0
                intervention["start"] = {**intervention["start"], "offsetMinutes": max(begin, math.ceil(proposal.eta_minutes))}
            decided_at = int(situation.at_minute or 0)
            if decided_at:
                # the backend honours `start`: offsets count from the scenario start, so a decision taken at T+N begins at N (+ its own delay)
                for key in ("start", "completeBy"):
                    spec = intervention.get(key)
                    if isinstance(spec, dict) and "offsetMinutes" in spec:
                        intervention[key] = {**spec, "offsetMinutes": spec["offsetMinutes"] + decided_at}
            action["simulationEffects"] = [intervention]
            action.update({key: value for key, value in proposal.extra_action_fields.items() if value is not None})
            if proposal.action_type == "fire_attack" and "line" not in action and "anchorPoint" not in action:
                # where the action works, in the fields the backend reads it from (``line`` / ``anchorPoint``): without them it cannot check that the
                # units can get there, nor compute and store their routes. The effect on the fire still comes from ``simulationEffects``.
                geometry = intervention.get("geometry") or {}
                if geometry.get("type") == "LineString":
                    action["line"] = geometry
                elif (point := proposal.target or centroid(geometry)) is not None:
                    action["anchorPoint"] = {"lat": point["lat"], "lon": point["lon"]}
            actions.append(action)
            summary.append(f"- **{message.agent_id}** ({message.tier.value}, {message.objective}): {message.reason}")
        if result.life and result.life.decisions:
            actions.extend(self._shelter_actions(result))
            summary.append("")
            summary.append(f"### Vidas ({result.life.report.line()})")
            summary.extend(f"- {d.reason}" for d in result.life.decisions)
        if result.staging:
            actions.extend(copy.deepcopy(result.staging))
            summary.append("")
            summary.append("### Meios em espera")
            summary.extend(f"- {a['rationale']} ({len(a['resources'])} unidades, {a['title']})" for a in result.staging)
        if result.traffic and result.traffic.actions:
            actions.extend(copy.deepcopy(result.traffic.actions))  # the same closures in both variants
            summary.append("")
            summary.append("### Trânsito (GNR)")
            summary.extend(f"- {a['rationale']}" for a in result.traffic.actions if a["type"] == "road_closure")
        if issues_lines:
            summary.append("")
            summary.append("### Ajustes do orchestrador")
            summary.extend(issues_lines)

        basis_time = situation.snapshot_time or datetime.now(UTC).isoformat()
        plan: dict[str, Any] = {
            "locationId": location_id,
            "title": f"{title_prefix} {variant} — {'vida em primeiro lugar' if life_first else 'árdida mínima'}",
            "variant": variant,
            "strategy": strategy,
            "summary": "\n".join(summary),
            "basis": {
                "simulationId": situation.simulation_id,
                "situationAsOf": basis_time,
            },
            "objectives": (
                [
                    {"objective": "protect_life", "weight": 1.0},
                    {"objective": "protect_buildings", "weight": 0.7},
                    {"objective": "minimize_burned_area", "weight": 0.4},
                ]
                if life_first
                else [
                    {"objective": "minimize_burned_area", "weight": 0.9},
                    {"objective": "protect_life", "weight": 0.8},
                    {"objective": "protect_buildings", "weight": 0.5},
                ]
            ),
            "alertLevel": _alert_level(result, life_first),
            "horizon": {
                "start": basis_time,
                "end": _plus_minutes(basis_time, situation.horizon_minutes),
            },
            "actions": actions,
            "assumptions": [
                "Todos os meios usados continuam disponíveis durante a janela do plano.",
                "Meteorologia mantém o padrão da simulação de base.",
            ],
        }
        return plan


# -------------------------------------------------------------------------------
# helpers
# -------------------------------------------------------------------------------
def _organization_of(message: DecisionMessage) -> str:
    return (message.organization_id or "").strip() or "org-unknown"


def _organization_of_agent(agent: Any) -> str:
    return (agent.observation.organization_id or "").strip() or "org-unknown"


def _alert_level(result: CycleResult, life_first: bool) -> str:
    if life_first and any(message.objective == "protect_life" for message in result.decisions):
        return "orange"
    if result.issues:
        return "yellow"
    return "yellow"


def _plus_minutes(instant: str, minutes: int) -> str:
    try:
        then = datetime.fromisoformat(instant)
    except ValueError:
        then = datetime.now(UTC)
    return (then + timedelta(minutes=minutes)).isoformat()


FOLLOW_UP_DELAY_MIN = 15
"""Minutes a follow-up waits when the action it depends on has no ``completeBy`` of its own (a building defence)."""


def _follow_up_delay(life_action: ActionProposal | None) -> int:
    """When plan A's combat starts: the evacuation's ``completeBy``, else a fixed delay."""
    complete_by = ((life_action.intervention.get("completeBy") or {}).get("offsetMinutes")) if life_action else None
    return int(complete_by) if complete_by else FOLLOW_UP_DELAY_MIN


def _area_first(
    ordered: list[tuple[DecisionMessage, ActionProposal]],
) -> tuple[list[tuple[DecisionMessage, ActionProposal]], set[int]]:
    """Plan B ("burned area first"): attack from minute 0 instead of after the life action.

    One unit does one thing at a time (the backend warns ``resource_conflict`` for a unit in two simultaneous
    actions), so a truck that plan A would have sent to evacuate/defend first only fights here, and a squad only
    evacuates. Returns the kept proposals and the ids of those that no longer wait for anything.
    """
    followers: dict[str, list[ActionProposal]] = {}
    for _message, proposal in ordered:
        if proposal.trigger and proposal.trigger.get("kind") == "on_action_complete":
            followers.setdefault(proposal.trigger.get("actionId"), []).append(proposal)
    dropped: set[int] = set()
    parallel: set[int] = set()
    for message, proposal in ordered:
        for follower in followers.get(proposal.proposal_id, []):
            if message.tier is FirefighterTier.TRUCK:
                dropped.add(id(proposal))
                parallel.add(id(follower))
            else:
                dropped.add(id(follower))
    return [(message, proposal) for message, proposal in ordered if id(proposal) not in dropped], parallel


def _sequenced(
    proposals_by_agent: dict[str, list[tuple[DecisionMessage, ActionProposal]]],
    life_first: bool,
) -> list[tuple[DecisionMessage, ActionProposal]]:
    """Order the proposals: variant A = evacuations first; variant B = suppression first."""
    flat: list[tuple[DecisionMessage, ActionProposal, int]] = []
    for pairs in proposals_by_agent.values():
        for index, (message, proposal) in enumerate(pairs):
            flat.append((message, proposal, index))
    evac = [entry for entry in flat if entry[1].action_type == "evacuation"]
    attack = [entry for entry in flat if entry[1].action_type != "evacuation"]

    def _key(entry: tuple[DecisionMessage, ActionProposal, int]) -> tuple[int, str, int]:
        message, proposal, index = entry
        return (0 if proposal.priority == "critical" else 1, message.agent_id, index)

    evac.sort(key=_key)
    attack.sort(key=_key)
    ordered = [*evac, *attack] if life_first else [*attack, *evac]
    return [(message, proposal) for message, proposal, _index in ordered]


__all__ = ["OrchestratorAgent", "CycleResult", "AgentIssue", "AgentRegistry"]
