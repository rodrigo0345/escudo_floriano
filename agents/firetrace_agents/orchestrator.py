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
import logging
import math
import os
import statistics
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Iterable, Sequence

from .client import ApiProblem, FiretraceClient
from .contracts import UNSAFE_ON_WIRE, validate_against_spec
from .firefighter import HANDLINE_BUILD_MIN, WET_LINE_BUILD_MIN, ActionProposal, DecisionMessage, FirefighterAgent, Situation, situation_from_simulation
from .advisor import (
    Advisor, AdvisorLog, NullAdvisor, evacuation_brief, sector_brief, sector_id, unit_brief, valid_closures, valid_evacuation_order, valid_sector_choice, valid_shelters,
    valid_standby,
)
from .buildings import DEFENDERS_PER_ZONE, BuildingZone, building_cells, ignition_minutes, zones_to_defend
from .daylight import minutes_to_sunset
from .duty import duty_factor, fuel_of, refill_setup_minutes
from .fuelbreak import plan_strip, plan_wet_line, strip_polygon
from .gnr import CHECKPOINT_PERSONNEL, DEFAULT_NO_EFFECT_KWM, GnrPlan, closure_action, control_point_action, intensity_lookup, nearest_units, plan_cordon, unit_stub
from .capacity import front_need_m, line_budget_m
from .life import DEFENDERS_PER_ITEM, ASSUMED_PEOPLE_UNKNOWN_FACILITY, AtRisk, Evacuator, LifePlan, plan_life
from .joint import link_organizations
from .placement import FireClock, black_site, defend_window, edge_site, stay_ahead, route_in_fire, wait_before
from .support import STANDBY_AMBULANCES, SupportAgents, SupportPlan
from .terrain import TerrainReader, apply_to_effect as apply_terrain_effect
from .sectors import Assignment, Sector, assign_units, bearing_to, destination, distance_m, line_across, outline_sectors, plan_sectors, slot_shift, with_preferences, zone_around
from .tiers import ORCHESTRATOR_ONLY, FirefighterTier, can_execute, explain_denial
from .travel import TravelPlanner, centroid


log = logging.getLogger("firetrace.orchestrator")

STAGING_DISTANCES_M = (300.0, 500.0, 800.0, 1600.0, 3200.0, 6400.0)  # how far from the fire a unit that cannot reach it waits, nearest first (each checked safe for the whole run)
ARRIVAL_STEP_MIN = 15  # units arriving within this of each other are placed on the same picture of the fire
AHEAD_STAY_MIN = 60  # how long a crew working ahead of the fire stays, at most (it leaves sooner if the fire comes sooner)
HOUSE_ZONE_RADIUS_M = 80.0  # a patch of houses the engines defend: about a street of houses across
FRONT_LOOKAHEAD_MIN = 30  # crews are placed on the front the fire will have this many minutes after the decision (a unit is there within about that): 60 put them kilometres ahead of a fast fire
FORCE_RADIUS_M = 900.0  # crews within this of each other are one group (a "grupo de combate")
FORCE_MIN_CREWS = 3  # a group this big gets an ambulance post of its own
FORWARD_POSTS = 2
SPOT_SPACING_M = 50.0  # crews closer than this are "in the same place"
MAX_CREWS_PER_SPOT = 6  # a task force: a real commander does not put a dozen engines on one spot while the rest of the edge burns; the others wait for the next wave
AIR_LEAD_MIN = 10  # an aircraft drops this long before the crews it supports arrive
AIR_SPACING_M = 180.0  # two aircraft do not prepare the same stretch (about one work zone apart)
MIN_USEFUL_WORK_MIN = 5  # a unit that would work less than this before the run ends is not sent (it stays free)
DIRECT_ATTACK_KWM = 12000.0  # DEMO BOOST (realistic 2500)  # = the engines' head-on test in firefighter.py: past this (or the rules' noEffectFromKwm, if lower) they attack indirectly
DIRECT_ATTACK_SPEED_MMIN = 25.0  # DEMO BOOST (realistic 8)  # ... or when the head runs faster than this
AIR_MIN_DAYLIGHT_MIN = 15  # an aircraft that would have less daylight than this left on arrival is not sent
AIR_DROP_WET_MIN = 30.0  # = firefighter.AIR_DROP_WET_MIN: how long one water drop keeps the ground wet
DEFAULT_AIR_WATER_KM = 5.0  # a helicopter's dip when no water point is known (farther = a longer rotation = weaker drops)
EARLY_AIR_KWM = 12000.0  # DEMO BOOST (realistic 2500)  # = Rules.suppression.fullEffectUpToKwm when /rules has none: past it before the crews arrive, the aircraft go at once
WORKABLE_EDGE_SHARE = 0.5  # a fire whose head is past direct attack is still attacked on its flanks while at least this share of its edge can be worked
MAX_ADVICE_SECTOR_CALLS = 4  # an advisor is asked about the sectors for at most this many groups of units per cycle (each group is a different picture of the fire); the rest follow the rules
COMBAT_EFFECTS = frozenset({"crew_deployment", "fire_line", "aerial_drop", "structure_protection", "fuel_removal"})


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
    unsafe_units: list[str] = field(default_factory=list)  # units with no spot they could work from before the fire reaches it: not sent
    held: list[str] = field(default_factory=list)  # units kept at their stations as a tactical reserve (plan B)
    support: Any = None  # what Proteção Civil and INEM added (``support.SupportPlan``)
    arrival_intensity: float | None = None  # the fire's intensity (kW/m) when the units get there: attack it, or contain it first
    advice: AdvisorLog = field(default_factory=AdvisorLog)  # what the advisor (an LLM commander) decided in this cycle, and what was thrown away (``advisor.py``)

    def assessment(self, rules: dict[str, Any] | None) -> str:
        """The firefighters' reading of the fire, in one sentence: attack to put it out, or contain it first (lives, then houses) and attack when it weakens."""
        limit = float((((rules or {}).get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)
        intensity = f"{self.arrival_intensity:.0f} kW/m" if self.arrival_intensity is not None else "desconhecida"
        if self.initial_attack:
            return (f"Intensidade quando os meios chegam: {intensity} (o ataque direto deixa de resultar a {limit:.0f} kW/m). **Atacar para apagar**: as equipas entram pelo lado já "
                    "ardido do perímetro à medida que chegam; os troços fortes demais são contidos à frente, em segurança.")
        return (f"Intensidade quando os meios chegam: {intensity}, acima do que o ataque direto aguenta ({limit:.0f} kW/m). **Conter primeiro**: proteger as pessoas e as casas, "
                "bloquear à frente do fogo só onde as equipas saem antes de ele chegar, e atacar para o apagar quando enfraquecer (as reavaliações fazem-no).")

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
        self._grids: dict[str, dict[str, Any]] = {}  # location → simulation grid (static, fetched once)
        self.origins: dict[str, dict[str, float]] = {}  # unit → where it is when it is not at its station (set by the re-plans: a crew leaves from its last job)
        self.unit_routes: dict[str, dict[str, Any]] = {}  # unit id → the road it was last routed along (station → job)
        self._clocks: dict[str, FireClock | None] = {}  # simulation → when its fire reaches each cell
        self._run_minutes = 0  # length of the run being planned (last `run_cycle`)
        self._sunset: float | None = None  # minutes from the scenario start until sunset there (last `run_cycle`): aircraft fly by day only
        self._location_id: str | None = None
        self._water: dict[tuple[float, float], float] = {}  # rounded target → km to the nearest water point a helicopter can dip into
        self._facilities: dict[str, list[dict[str, Any]]] = {}  # location → facilities (static, fetched once)
        # The ground each crew works on (slope, fuel, water): the backend does not slow a crew on a steep slope, so the agents do (`terrain.py`). Each is a switch.
        self.terrain_enabled = os.environ.get("AGENTS_TERRAIN", "1").lower() not in {"0", "false", "no"}
        self.real_refill = os.environ.get("AGENTS_REAL_REFILL", "1").lower() not in {"0", "false", "no"}
        self._terrain: dict[str, TerrainReader] = {}  # location → asked-once terrain and refill distances
        self.advisor: Advisor = NullAdvisor()  # an LLM commander may be plugged in (``llm/``): it chooses among options the rules offer, and may be wrong without harm
        self._advising = False  # the cycle being planned consults the advisor
        self._advice = AdvisorLog()
        self._advice_calls = 0

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
        air_support: bool = False,
        reserve_share: float = 0.0,
        defend_whole_run: bool = False,
        defenders_per_zone: int = DEFENDERS_PER_ZONE,
        force_contain: bool = False,
        early_air: bool = True,
        validate: bool = True,
        use_advisor: bool = False,
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
        ``air_support`` (implied by ``fuel_breaks``) times the aircraft with the crews: each drops on the stretch the next crews go in to (see ``_air_support``).
        ``reserve_share`` keeps that share of the combat units at their stations as a tactical reserve (the farthest ones): free for the re-plans along the fire.
        ``defend_whole_run`` (plan B) defends every patch of houses the forecast fire reaches in the whole run, not only those it reaches before the crews could
        stop it, with ``defenders_per_zone`` engines each (each prepares its patch and leaves before the fire arrives, see ``_place_safely``).
        ``force_contain`` contains the fire even when the engine's test would attack it; ``early_air=False`` keeps the aircraft timed with the crews
        instead of the early air attack on the head (both are the LLM commander's choices, see ``commander/schema.py``).
        ``lean`` and ``reserve_share`` only apply when the fire must be contained: while it can be put out (``initial_attack``) every unit that arrives in time attacks.
        A combat unit that would arrive with under ``MIN_USEFUL_WORK_MIN`` of the run left is not sent.
        Every crew is placed where it is safe (``placement.py``): an initial attack works from the burned side of the edge at the minute the crew arrives, and a
        crew working ahead of the fire leaves before it gets there; a crew with no safe spot is not sent (it stays free for later).
        ``use_advisor`` asks ``self.advisor`` (an LLM commander, see ``advisor.py``) at the places it may decide: which sector each unit works, the order of the
        evacuations and their shelters, which road closures are enforced, where the ambulances wait, and a final note; whatever it gets wrong is discarded and the rules decide.
        """
        self._begin_advice(use_advisor)
        simulation = self._simulation(simulation_id)
        ignitions = ((simulation or {}).get("scenarioSnapshot") or {}).get("ignitions") or []
        self._run_minutes = int(((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes") or 0)
        self._location_id = location_id
        start, where = ((simulation or {}).get("scenarioSnapshot") or {}).get("start"), (ignitions[0].get("position") if ignitions else None)
        self._sunset = minutes_to_sunset(str(start), float(where["lat"]), float(where["lon"])) if start and where else None  # aircraft stop then
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

        result = CycleResult(simulation_id=simulation_id, advice=self._advice)
        situation, result.attack_lead, result.initial_attack = self._initial_attack(situation, location_id, travel)
        if force_contain and result.initial_attack:  # the commander chose to contain although the engine's test would attack
            situation, result.initial_attack = replace(situation, initial_attack=False, work_minutes=AHEAD_STAY_MIN), False
        decided = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        result.arrival_intensity = intensity_lookup(situation.summary)(decided + (result.attack_lead or 0.0))  # what the crews find when they get there
        # The engines that defend houses are set aside first: taken out of a barrier already laid they would leave a gap in it.
        result.zones, reserved = self._plan_buildings(situation, location_id, building_zones, stage_minutes, result, whole_run=defend_whole_run, per_zone=defenders_per_zone)
        groups = self._arrival_groups(situation, [a.agent_id for a in self.agents if a.agent_id not in reserved]) if result.initial_attack else []
        if groups:
            everyone = {a.agent_id for a in self.agents}
            result.assignments = {}
            carried: set[str] = set()
            placed: list[tuple[set[str], float]] = []
            for ids, lead in groups:  # the units that arrive together are placed on the fire where it will be when they get there
                members = ids | carried
                given = self._assign_sectors(situation, simulation, stage_minutes, concentration, exclude=(everyone - members) | set(reserved), lead=lead)
                result.assignments.update(given)
                # a unit the front had no room for when it arrived is still there, and nearer than the next group: it takes the front with them, before them
                carried = {i for i in members if (a := given.get(i)) is None or (a.sector is None and a.place is None)}
                placed.append((members - carried, lead))
            if carried:
                placed[-1] = (placed[-1][0] | carried, placed[-1][1])
            groups = placed
        else:
            result.assignments = self._assign_sectors(situation, simulation, stage_minutes, concentration, exclude=set(reserved), lead=result.attack_lead if result.initial_attack else None)
        result.life = self._plan_life(situation, location_id, result.assignments, exclude=set(reserved), zones=result.zones)
        result.assignments.update({agent_id: Assignment(place=asset) for agent_id, asset in reserved.items()})
        if result.initial_attack:
            result.attack_zones, result.attack_crews = self._fit_on_outline(situation, result, groups)
        if travel:  # plan A's fuel breaks, and (A and B) indirect lines wherever the fire is too strong to attack head-on
            result.fuel_strips = self._fuel_breaks(situation, location_id, result, ((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes"), squads_always=fuel_breaks)
        if travel:
            result.unsafe_units = self._place_safely(situation, location_id, result)
        if (fuel_breaks or air_support) and travel:
            self._air_support(result, situation, early=early_air)
        # A reserve only makes sense when the fire must be contained: while it can still be put out, every unit that gets there in time attacks
        # (B too; on Penha, holding back two engines meant for the head let the fire escape: 9 ha with them, 612 ha without).
        holding = not result.initial_attack
        result.held = self._hold_reserve(result, reserve_share) if reserve_share > 0 and holding else []
        if travel:
            crowded = [i for i in self._space_crews(situation, result) if i not in result.held]
            if crowded:
                result.held = [*result.held, *crowded]  # no room for them on the edge yet: forward reserve, drawn on by the next waves (adaptation.py)
                result.issues.append(AgentIssue("orchestrator", "equipas", f"{len(crowded)} meios ficam em reserva avançada: já há {MAX_CREWS_PER_SPOT} equipas em cada ponto do perímetro (entram nas próximas reavaliações)."))
        for agent in self.agents:
            assignment = result.assignments.get(agent.agent_id)
            if lean and holding and assignment is not None and assignment.reserve:
                continue  # a lean plan commits only the units the outline has room for; the reserve stays at its stations
            if agent.agent_id in result.held or (assignment is not None and assignment.stay_minutes == 0):
                continue  # tactical reserve, or no spot it could work from without the fire reaching it: it stays free for the next decision
            message = agent.decide(situation, assignment)
            result.decisions.append(message)
        for agent_id in result.unsafe_units:
            result.issues.append(AgentIssue(agent_id, "posição", "not sent: no spot it could work from before the fire reaches it (it stays free for the next decision)."))

        guarded = self._guard_decisions(result)
        if travel:
            guarded = self._apply_travel(guarded, situation, location_id, result)
            if result.held:  # plan B's reserve waits close to the fire, not at the stations
                try:
                    anchor = situation.anchor
                except ValueError:
                    anchor = None
                if anchor is not None:
                    agents = {a.agent_id: a for a in self.agents}
                    held = {i: (agents[i], "reserva", anchor) for i in result.held if i in agents}
                    result.staging = [*result.staging, *self._stage(held, situation, location_id, result, reserve=True)]
        if traffic:
            result.traffic = self._plan_traffic(
                situation, location_id, result, travel=travel, duration=((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes"),
            )
        plan_a = self._compose_plan(guarded, result, situation, variant="A", location_id=location_id, title_prefix=title_prefix)
        plan_b = self._compose_plan(guarded, result, situation, variant="B", location_id=location_id, title_prefix=title_prefix)
        result.plan_a, result.plan_b = plan_a, plan_b
        if traffic:  # the organizations' part (with the GNR's): once per plan, not again in every re-plan
            run_minutes = int(((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes") or situation.life_horizon_minutes)
            support, agents = self._support(situation, location_id, result, run_minutes)
            people = {d.item.id: (d.item.people, d.item.vulnerable, str((d.item.asset.get("details") or {}).get("kind") or d.item.asset.get("kind") or "")) for d in (result.life.decisions if result.life else ())}
            shelters = self._advised_shelters(agents, plan_a, people)
            for plan in (plan_a, plan_b):
                plan["actions"].extend(copy.deepcopy(support.actions))
                if agents is not None:
                    for message in agents.enrich_evacuations(plan, people, support.ambulances_left, shelters):
                        result.issues.append(AgentIssue("proteção civil", "evacuação", message))
            result.support = support
            self._joint_operations(plan_a, plan_b, result, support, agents, situation)
        self._advised_review(result, plan_a, situation)

        if validate or publish:  # the callers that judge the plans themselves (alternatives, re-plans) validate later, once
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
        the median of the units' routes to the fire is the lead. If the fire is still below that intensity at that minute (or its head is past it but most
        of its edge, the flanks, is not: ``_workable_edge``) the situation is
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
            planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=False, origins=self.origins)
            self._arrival = {a.agent_id: float(r.arrival_minutes) for a in self.agents if a.tier is not FirefighterTier.HELICOPTER and (r := planner.eta(a, target)).reachable and r.arrival_minutes is not None}
            etas = list(self._arrival.values())
            lead = float(statistics.quantiles(etas, n=100, method="inclusive")[max(0, min(98, round(self.lead_quantile * 100) - 1))]) if len(etas) > 1 else (float(etas[0]) if etas else None)
        if lead is None:
            return situation, None, False
        lead = min(lead, float(situation.horizon_minutes))
        rules = situation.rules or {}
        limit = float(((rules.get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)
        # the units do not arrive together (see `_arrival_groups`): the attack is on if the first group of them (those within ``ARRIVAL_STEP_MIN`` of the first)
        # can still work when they get there; the groups that arrive after the fire outgrew direct attack are dealt with on their own (`_fit_on_outline`).
        # (A median over the early half moved with every unit added: a crew pre-positioned next to the fire pushed it past the minute the fire crowned.)
        ordered = sorted(self._arrival.values())
        first = [e for e in ordered if ordered and e <= ordered[0] + ARRIVAL_STEP_MIN]
        first_lead = min(float(statistics.median(first)), lead) if first else lead
        if intensity_lookup(situation.summary)(decided_at + first_lead) >= limit and not self._workable_edge(situation, decided_at + first_lead, limit):
            return situation, lead, False
        work = int(((rules.get("crews") or {}).get("maxContinuousWorkMinutes")) or 240)
        return replace(situation, initial_attack=True, work_minutes=work), lead, True

    def _workable_edge(self, situation: Situation, minute: float, limit: float) -> bool:
        """When the head is past direct attack: is a good share of the edge still workable (the flanks)? Crews anchor and work the flanks of a fire whose head
        cannot be fought; the backend faces each crew with the intensity in the direction the fire spreads into its ground (see ``sectors.plan_sectors``).
        True if at least ``WORKABLE_EDGE_SHARE`` of the stretches the fire has at ``minute`` burn below ``limit`` in their own direction."""
        try:
            vectors = self.client.get_vectors(situation.simulation_id, t_min=int(round(minute)))
        except ApiProblem:
            return False
        stretches = plan_sectors(vectors, zone_radius_m=situation.zone_radius_m, limit=50)
        stretches = self._with_outline(situation, stretches, int(round(minute)))
        return bool(stretches) and sum(s.intensity_kwm < limit for s in stretches) >= WORKABLE_EDGE_SHARE * len(stretches)

    def _fuel_breaks(self, situation: Situation, location_id: str, result: CycleResult, duration: int | None, *, squads_always: bool = True) -> int:
        """Indirect attack ahead of the fire, where the crew can finish before the fire gets there. Returns how many units do it.

        Squads that are not on the fire's outline clear a strip of fuel (always with ``squads_always``, plan A's fuel breaks; otherwise only where the fire is too
        strong for direct attack). Engines lay a wet line where the fire is too strong for them to attack head-on (``_too_strong``): the backend fades direct
        attack to nothing past ``noEffectFromKwm`` but not a line already in place, so that is how a fire past that limit is still slowed.
        """
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=True, origins=self.origins)
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
            if agent.tier is FirefighterTier.HELICOPTER or assignment is None or assignment.sector is None or assignment.place is not None:
                continue
            if situation.initial_attack and not assignment.reserve:
                continue  # on the outline: it attacks the fire where it is
            too_strong = self._too_strong(situation, assignment.sector)
            travel = lambda point, a=agent: planner.eta(a, point)  # noqa: E731
            if agent.tier is FirefighterTier.SQUAD:
                if not (squads_always or too_strong):
                    continue
                strip = plan_strip(assignment.sector, agent.observation.crew_onboard, decided_at, travel=travel, perimeters_at=perimeters_at)
            elif too_strong:
                # each engine lays its own line: moved along the front by its slot, so engines on one sector do not stack the same line
                along = (assignment.sector.bearing_deg + 90.0) % 360.0
                lat, lon = destination(assignment.sector.lat, assignment.sector.lon, along, slot_shift(assignment.slot, 2.0 * situation.zone_radius_m))
                shifted = replace(assignment.sector, lat=lat, lon=lon)
                strip = plan_wet_line(shifted, decided_at, travel=travel, perimeters_at=perimeters_at)
            else:
                continue  # an engine that can still attack head-on does so
            if strip is not None:
                result.assignments[agent.agent_id] = replace(assignment, fuel_strip=strip)
                count += 1
        return count

    @staticmethod
    def _too_strong(situation: Situation, sector: Sector) -> bool:
        """Is the fire on this stretch past what direct attack can do (the engines' own test in ``firefighter.py``, with the rules' ``noEffectFromKwm`` as the ceiling)?"""
        limit = float((((situation.rules or {}).get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)
        return sector.intensity_kwm >= min(limit, DIRECT_ATTACK_KWM) or sector.speed_mmin > DIRECT_ATTACK_SPEED_MMIN

    def _arrival_groups(self, situation: Situation, unit_ids: list[str]) -> list[tuple[set[str], float]]:
        """The units grouped by when they reach the fire (every ``ARRIVAL_STEP_MIN``): (units, minutes until they are there).

        This is how a commander receives them: each unit is given ground on the fire as it is when that unit arrives, not where the fire was when the call came
        nor where it will be when the last unit arrives. Aircraft and units with no route time go with the first group.
        """
        etas = {i: self._arrival[i] for i in unit_ids if i in self._arrival}
        if not etas:
            return []
        buckets: dict[int, set[str]] = {}
        for unit, eta in etas.items():
            buckets.setdefault(int(eta // ARRIVAL_STEP_MIN), set()).add(unit)
        groups: list[tuple[set[str], float]] = []
        for index, key in enumerate(sorted(buckets)):
            members = buckets[key]
            lead = min(float(statistics.median(etas[i] for i in members)), float(situation.horizon_minutes))
            groups.append((members | (set(unit_ids) - set(etas) if index == 0 else set()), lead))
        return groups

    def _place_safely(self, situation: Situation, location_id: str, result: CycleResult) -> list[str]:
        """Give every crew a spot it can work from without the fire reaching it (``placement.py``). Returns the units that have none (they are not sent).

        A crew on the outline works from the burned side of the edge, at the minute it arrives (a step along the edge per slot, so crews on the same stretch do
        not stand on one spot); with no burned ground within its reach yet it works ahead of the fire instead, like a crew in reserve, and leaves before the
        fire gets there.
        """
        clock = self._fire_clock(situation, location_id, result)
        if clock is None:
            return []
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        unsafe: list[str] = []
        planner: TravelPlanner | None = None
        for agent in self.agents:
            assignment = result.assignments.get(agent.agent_id)
            eta = self._arrival.get(agent.agent_id)
            houses = assignment is not None and assignment.place is not None and assignment.place.get("position") and assignment.place.get("assetType") == "building_zone"
            if houses and agent.tier is not FirefighterTier.HELICOPTER:
                # timed on its own road to the houses, not on the drive to the fire (which a unit sent from the field may not even have)
                planner = planner or TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules,
                                                   cache=self._routes, avoid_fire=True, origins=self.origins)
                route = planner.eta(agent, assignment.place["position"])
                eta = float(route.arrival_minutes) if route.reachable and route.arrival_minutes is not None else eta
            if agent.tier is FirefighterTier.HELICOPTER or assignment is None or eta is None:
                continue
            arrive = decided_at + eta
            if houses:
                # a patch of houses: the engine gets there in time to prepare it, not hours before the fire (nor after it has burned), and leaves before the fire arrives
                fire_in = (assignment.place.get("arrivalMinute") or {}).get("p50")
                stay, wait = defend_window(clock, assignment.place["position"], arrive, decided_at + float(fire_in) if fire_in is not None else None)
                result.assignments[agent.agent_id] = replace(assignment, stay_minutes=stay, start_after=eta + wait if wait >= 1 else None)
                if stay == 0:
                    unsafe.append(agent.agent_id)
                continue
            if assignment.place is not None and assignment.place.get("position"):
                # evacuating a place: the crew goes at once and leaves before the fire gets there (a crew that would arrive too late is not sent)
                stay = stay_ahead(clock, assignment.place["position"], arrive, situation.work_minutes if situation.initial_attack else AHEAD_STAY_MIN * 2)
                result.assignments[agent.agent_id] = replace(assignment, stay_minutes=stay)
                if stay == 0:
                    unsafe.append(agent.agent_id)
                continue
            if assignment.sector is None or assignment.place is not None or assignment.fuel_strip is not None:
                continue
            if situation.initial_attack and not assignment.reserve:
                along = (assignment.sector.bearing_deg + 90.0) % 360.0
                lat, lon = destination(assignment.sector.lat, assignment.sector.lon, along, slot_shift(assignment.slot, 2.0 * situation.zone_radius_m))
                stretch = replace(assignment.sector, lat=lat, lon=lon)
                site = black_site(clock, stretch, arrive, situation.work_minutes, situation.zone_radius_m)
                if site is not None:
                    result.assignments[agent.agent_id] = replace(assignment, site=site, stay_minutes=situation.work_minutes)
                    continue
                # a young fire has no black yet: its back and weak flanks are attacked at the edge, from just ahead of it, while that is safe
                edge = edge_site(clock, stretch, arrive, situation.work_minutes, situation.zone_radius_m)
                if edge is not None:
                    result.assignments[agent.agent_id] = replace(assignment, site=edge[0], stay_minutes=edge[1])
                    continue
                assignment = replace(assignment, reserve=True)  # no burned ground within its reach yet: it works ahead of the fire, while that is safe
            stay = stay_ahead(clock, assignment.sector.position, arrive, AHEAD_STAY_MIN)
            direct = agent.tier is FirefighterTier.TRUCK and not self._too_strong(situation, assignment.sector)
            build = None if direct else (WET_LINE_BUILD_MIN if agent.tier is FirefighterTier.TRUCK else HANDLINE_BUILD_MIN)  # its line (firefighter.py's fallback)
            if build is not None and stay < build:
                stay = 0  # it would leave before its line is finished: an unfinished line holds nothing, and the fire gets to it first
            if build is not None and (burned := clock.reached(assignment.sector.lat, assignment.sector.lon)) is not None and burned <= arrive:
                stay = 0  # a line on ground the fire has already burned holds nothing (stay_ahead counts burned-out ground as safe to stand on, which it is)
            # a direct attack works only while the crew is there: it sets off so as to be working when the fire comes, not an hour before it
            wait = wait_before(clock, assignment.sector.position, arrive, stay) if stay and direct else 0.0
            result.assignments[agent.agent_id] = replace(assignment, stay_minutes=stay, start_after=eta + wait if wait >= 1 else assignment.start_after)
            if stay == 0:
                unsafe.append(agent.agent_id)
        return unsafe

    def _joint_operations(self, plan_a: dict[str, Any], plan_b: dict[str, Any], result: CycleResult, support: SupportPlan, agents: SupportAgents | None, situation: Situation) -> None:
        """The corporations work together (``joint.py``): an ambulance post beside each big group of crews, then every action that belongs with another's is linked to it."""
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        spots = [spot for agent in self.agents if (a := result.assignments.get(agent.agent_id)) is not None and a.place is None and agent.agent_id not in result.held
                 and agent.tier is not FirefighterTier.HELICOPTER and (spot := self._crew_spot(situation, a)) is not None]
        groups: list[list[dict[str, float]]] = []
        for spot in spots:
            home = next((g for g in groups if distance_m(spot["lat"], spot["lon"], g[0]["lat"], g[0]["lon"]) <= FORCE_RADIUS_M), None)
            if home is None:
                groups.append([spot])
            else:
                home.append(spot)
        extra: list[dict[str, Any]] = []
        if agents is not None and support.ambulances_left:
            for index, group in enumerate(sorted((g for g in groups if len(g) >= FORCE_MIN_CREWS), key=len, reverse=True)[:FORWARD_POSTS], start=1):
                agents.ambulances = list(support.ambulances_left)
                post = agents.medical_standby(group, situation.head_bearing_deg, decided_at)
                support.ambulances_left = post.ambulances_left
                for action in post.actions:
                    action["id"] = f"inem-forward-{index}"
                    action["title"] = f"INEM junto do grupo de combate {index} ({len(group)} equipas, {len(action.get('resources') or [])} ambulâncias)"
                    extra.append(action)
        gnr_org, civil_org = self._gnr_organization(), self._command_organization()
        medical_org = agents.medical_org if agents is not None else ""
        made = 0
        for plan in (plan_a, plan_b):
            plan["actions"].extend(copy.deepcopy(extra))
            made = link_organizations(plan["actions"], gnr_org=gnr_org, civil_org=civil_org, medical_org=medical_org)
        if extra or made:
            result.issues.append(AgentIssue("orchestrator", "operações conjuntas", f"{made} operações conjuntas (GNR, INEM, Proteção Civil e Bombeiros ligados); {len(extra)} postos do INEM junto dos grupos de combate."))

    def _safe_planner(self, planner: TravelPlanner, location_id: str, situation: Situation) -> TravelPlanner:
        """The same routing, but around the predicted fire (an initial attack routes straight at it, because its target is the fire)."""
        if planner.avoid_fire:
            return planner
        return TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=True, origins=self.origins)

    def _crew_spot(self, situation: Situation, assignment: Assignment) -> dict[str, float] | None:
        """Where a ground crew works, as the agents place it: its safe spot, else its sector's front moved along the edge by its slot (``firefighter._zone``)."""
        if assignment.site is not None:
            return {"lat": float(assignment.site["lat"]), "lon": float(assignment.site["lon"])}
        if assignment.sector is None:
            return None
        along = (assignment.sector.bearing_deg + 90.0) % 360.0
        lat, lon = destination(assignment.sector.lat, assignment.sector.lon, along, slot_shift(assignment.slot, 2.0 * situation.zone_radius_m))
        return {"lat": lat, "lon": lon}

    def _space_crews(self, situation: Situation, result: CycleResult) -> list[str]:
        """The units that would stand on a spot that already has ``MAX_CREWS_PER_SPOT`` crews within ``SPOT_SPACING_M`` (the ones that arrive first keep the spot).

        Crews working a fuel strip or a wet line have a line of their own, units that look after a place go to it, and aircraft do not stand anywhere: none of them counts.
        """
        placed: list[dict[str, float]] = []
        crowded: list[str] = []
        for agent in sorted((a for a in self.agents if a.agent_id in result.assignments), key=lambda a: (self._arrival.get(a.agent_id, 1e9), a.agent_id)):
            assignment = result.assignments[agent.agent_id]
            if agent.tier is FirefighterTier.HELICOPTER or assignment.place is not None or assignment.fuel_strip is not None or assignment.stay_minutes == 0:
                continue
            spot = self._crew_spot(situation, assignment)
            if spot is None:
                continue
            if sum(distance_m(spot["lat"], spot["lon"], q["lat"], q["lon"]) <= SPOT_SPACING_M for q in placed) >= MAX_CREWS_PER_SPOT:
                crowded.append(agent.agent_id)
                continue
            placed.append(spot)
        return crowded

    def _fire_clock(self, situation: Situation, location_id: str, result: CycleResult) -> FireClock | None:
        """When the forecast fire reaches each cell (the simulation's ignition grid), cached per simulation; ``None`` (and an issue) if the server has no grid."""
        clock, error = self.fire_clock(situation.simulation_id, location_id)
        if error is not None:
            result.issues.append(AgentIssue("orchestrator", "safe placement", f"not checked [{getattr(error, 'code', 'no_grid')}]: {error}"))
        return clock

    def fire_clock(self, simulation_id: str, location_id: str) -> tuple[FireClock | None, Exception | None]:
        """``_fire_clock`` without a cycle: the clock (``None`` when the server has no grid) and what went wrong, if anything."""
        if simulation_id in self._clocks:
            return self._clocks[simulation_id], None
        error: Exception | None = None
        try:
            if location_id not in self._grids:
                self._grids[location_id] = self.client.get_location(location_id)["grid"]
            clock: FireClock | None = FireClock(self._grids[location_id], ignition_minutes(self.client.get_ignition_grid(simulation_id)))
        except (ApiProblem, KeyError) as caught:
            error, clock = caught, None
        if len(self._clocks) > 8:
            self._clocks.clear()
        self._clocks[simulation_id] = clock
        return clock, error

    def _support(self, situation: Situation, location_id: str, result: CycleResult, run_minutes: int) -> tuple[SupportPlan, SupportAgents | None]:
        """Proteção Civil and INEM (``support.py``): medical standby behind the crews, the command post and the public alerts; the evacuations are completed later."""
        try:
            if location_id not in self._facilities:
                self._facilities[location_id] = self.client.list_facilities(location_id)
            ambulances = [v for v in self.client.list_vehicles(capability="evacuation_transport", status="available") if v.get("type") == "ambulance"]
            medical = self.client.list_organizations("inem")
        except ApiProblem as error:
            result.issues.append(AgentIssue("support", "Proteção Civil / INEM", f"not planned [{error.code}]: {error}"))
            return SupportPlan(), None
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes)
        agents = SupportAgents(
            self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, clock=self._fire_clock(situation, location_id, result),
            run_minutes=run_minutes, civil_org=self._command_organization(), medical_org=str(medical[0]["id"]) if medical else (str(ambulances[0].get("organizationId")) if ambulances else "org-inem"),
            facilities=self._facilities[location_id], ambulances=ambulances, station_position=planner.station_position, route=lambda vehicle, point: planner.eta(unit_stub(vehicle), point),
        )
        sites = [a.site for a in result.assignments.values() if a.site is not None] or [a.sector.position for a in result.assignments.values() if a.sector is not None and a.place is None][:6]
        plan = agents.medical_standby(sites, situation.head_bearing_deg, decided_at, self._advised_standby(agents, sites, situation.head_bearing_deg, ambulances))
        try:
            post = agents.command_post(situation.anchor)
        except ValueError:
            post = None
        if post is not None:
            plan.actions.append(post)
        plan.actions.extend(agents.public_alerts(list(result.life.decisions) if result.life else [], decided_at))
        for message in plan.issues:
            result.issues.append(AgentIssue("support", "Proteção Civil / INEM", message))
        return plan, agents

    def _air_support(self, result: CycleResult, situation: Situation, *, early: bool = True) -> None:
        """The aircraft (A and B) prepare the ground for the crews: each drops on the stretch where the next crews go in, ``AIR_LEAD_MIN`` before they get there.

        The drop cools the edge the crew is about to work from (its effect is temporary), instead of every aircraft hitting the head on its own.
        But when the fire will outgrow direct attack before the first crews get there (it is about to go into the crowns), the aircraft are the only ones in
        time: they go at once and keep dropping on its head until the crews arrive (``_early_air_attack``).
        """
        crews = sorted(
            ((self._arrival[a.agent_id], result.assignments[a.agent_id]) for a in self.agents
             if a.agent_id in self._arrival and (s := result.assignments.get(a.agent_id)) is not None and s.site is not None and s.sector is not None),
            key=lambda pair: pair[0],
        )
        aircraft = [a for a in self.agents if a.tier is FirefighterTier.HELICOPTER and a.agent_id in result.assignments and result.assignments[a.agent_id].place is None]
        # when the attack is built up: the median arrival of the crews working the fire's edge, else of all the units (the attack's lead). One crew stationed
        # next to the fire is not an attack: the aircraft hold the fire until the bulk of the crews is there
        etas = [e for e, _a in crews] or list(self._arrival.values())
        first_ground = float(statistics.median(etas)) if etas else None
        if early and aircraft and first_ground is not None and self._early_air_attack(situation, result, aircraft, first_ground + AIR_LEAD_MIN):
            return
        if not result.initial_attack:
            self._air_off_the_head(result, situation, aircraft)  # no crews on the outline to prepare the ground for: the aircraft keep their own sectors, where drops still work
            return
        targets: list[tuple[float, Sector]] = []
        for eta, assignment in crews:  # one stretch per aircraft, in the order the crews arrive
            if all(distance_m(assignment.sector.lat, assignment.sector.lon, s.lat, s.lon) > 2 * AIR_SPACING_M for _e, s in targets):
                targets.append((eta, assignment.sector))
        if not targets and result.assignments:
            limit = self._no_effect_kwm(situation)
            active = [a.sector for a in result.assignments.values() if a.sector is not None and a.sector.intensity_kwm < limit]
            for s in active:
                if all(distance_m(s.lat, s.lon, other.lat, other.lon) > 2 * AIR_SPACING_M for _e, other in targets):
                    targets.append((0.0, s))
        for idx, agent in enumerate(aircraft):
            if targets:
                eta, sector = targets[idx % len(targets)]
                slot = idx % 2
                stagger = (idx // len(targets)) * 3.0
                site = {"lat": sector.lat, "lon": sector.lon}
                line = line_across(sector.lat, sector.lon, sector.bearing_deg, situation.zone_radius_m, slot)
                result.assignments[agent.agent_id] = replace(
                    result.assignments[agent.agent_id],
                    sector=sector,
                    site=site,
                    air_line=line,
                    air_corridor=None,
                    start_after=max(eta - AIR_LEAD_MIN + stagger, 0.0),
                    slot=slot,
                )

    @staticmethod
    def _no_effect_kwm(situation: Situation) -> float:
        """``Rules.suppression.noEffectFromKwm``: past it the backend gives direct attack (crews and drops) no effect at all."""
        return float((((situation.rules or {}).get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)

    @staticmethod
    def _air_lead(aircraft: list[FirefighterAgent], target: dict[str, Any], planner: TravelPlanner) -> float:
        """Median minutes until the aircraft are over ``target`` (0 when none can say)."""
        etas = [float(r.arrival_minutes) for a in aircraft if (r := planner.eta(a, target)).reachable and r.arrival_minutes is not None]
        return float(statistics.median(etas)) if etas else 0.0

    def _air_workable(self, situation: Situation, minute: float) -> list[Sector]:
        """The stretches of the fire's edge at ``minute`` that drops can still hold: burning below ``noEffectFromKwm`` in their own direction (a flank faces a
        fraction of what the head burns at), the most dangerous first and about one work zone apart. Empty when there is none, or no vectors."""
        limit = self._no_effect_kwm(situation)
        try:
            vectors = self.client.get_vectors(situation.simulation_id, t_min=int(round(minute)))
        except ApiProblem:
            return []
        sectors = self._with_outline(situation, plan_sectors(vectors, zone_radius_m=situation.zone_radius_m, limit=50), int(round(minute)))
        picked: list[Sector] = []
        for sector in sorted((s for s in sectors if s.intensity_kwm < limit), key=lambda s: s.danger, reverse=True):
            if all(distance_m(sector.lat, sector.lon, other.lat, other.lon) > 2 * AIR_SPACING_M for other in picked):
                picked.append(sector)
        return picked

    def _air_off_the_head(self, result: CycleResult, situation: Situation, aircraft: list[FirefighterAgent]) -> None:
        """The aircraft whose own sector (the most dangerous third, ``sectors.HELICOPTER_SHARE``) burns past ``noEffectFromKwm`` drop on the workable flanks and
        back instead, two to a stretch: water on a crown run does nothing, on its flanks it narrows the fire."""
        limit = self._no_effect_kwm(situation)
        moving = [a for a in aircraft if (s := result.assignments[a.agent_id].sector) is not None and s.intensity_kwm >= limit]
        if not moving:
            return
        try:
            anchor = situation.anchor
        except ValueError:
            return
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        planner = TravelPlanner(self.client, location_id=str(self._location_id), simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules,
                                cache=self._routes, avoid_fire=False, origins=self.origins)
        workable = self._air_workable(situation, decided_at + self._air_lead(moving, anchor, planner))
        if not workable:
            return
        for idx, agent in enumerate(moving):
            sector, slot = workable[(idx // 2) % len(workable)], idx % 2
            result.assignments[agent.agent_id] = replace(
                result.assignments[agent.agent_id], sector=sector, site={"lat": sector.lat, "lon": sector.lon},
                air_line=line_across(sector.lat, sector.lon, sector.bearing_deg, situation.zone_radius_m, slot), air_corridor=None, slot=slot,
            )
        result.issues.append(AgentIssue("orchestrator", "meios aéreos", f"{len(moving)} aircraft drop on the flanks and back ({len(workable)} stretches below {limit:.0f} kW/m): the head burns past what water can stop."))

    def _air_rotation(self, unit: FirefighterAgent, target: dict[str, Any] | None, situation: Situation) -> tuple[float, float]:
        """An aircraft's rotation, as the rules count it (``Rules.aerial.cycleTime``: 2 × distance(water → target) / speed + load + drop), and that distance in km.

        A helicopter dips into the nearest water point it can use (``helicopterAccessible``); an amphibious airtanker scoops from a large water body
        (``metadata["agents.scoopDistanceKm"]``); with neither known, ``DEFAULT_AIR_WATER_KM``."""
        aerial = unit.observation.aerial or {}
        rules = ((situation.rules or {}).get("aerial") or {}).get("helicopter") or {}
        speed = float(aerial.get("cruiseSpeedKmh") or (unit.observation.profile or {}).get("speedKmh") or rules.get("cruiseSpeedKmh") or 180.0)
        load = float(aerial.get("loadMinutes") or rules.get("loadMinutes") or 1.0)
        drop = float(aerial.get("dropMinutes") or rules.get("dropMinutes") or 1.0)
        km = unit.observation.scoop_km or (self._water_km(target) if target is not None else DEFAULT_AIR_WATER_KM)
        return 2 * km / max(speed, 1.0) * 60.0 + load + drop, km

    def _water_km(self, target: dict[str, Any]) -> float:
        key = (round(float(target["lat"]), 2), round(float(target["lon"]), 2))
        if key not in self._water:
            try:
                near = self.client.water_points_near(str(self._location_id), float(target["lat"]), float(target["lon"]), helicopter_only=True) if self._location_id else []
            except ApiProblem:
                near = []
            self._water[key] = float(near[0]["distanceM"]) / 1000.0 if near and near[0].get("distanceM") is not None else DEFAULT_AIR_WATER_KM
        return self._water[key]

    def _early_air_attack(self, situation: Situation, result: CycleResult, aircraft: list[FirefighterAgent], until: float) -> bool:
        """If the fire burns past full-strength direct attack (``fullEffectUpToKwm``) before ``until`` minutes from the decision, the aircraft attack it at once.

        A helicopter's rotation is a few minutes (``Rules.aerial``: 2 × distance to water / speed + load + drop), so from its arrival to the crews' it keeps
        dropping on the head: one drop over the corridor the head runs along in that time (where the fire is now → where its head will be), lasting until
        the crews arrive. Keeping the surface fire low there is what holds it out of the crowns until the crews can attack it. Returns whether it did.
        """
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        full = float((((situation.rules or {}).get("suppression") or {}).get("fullEffectUpToKwm")) or EARLY_AIR_KWM)
        crown_at = min(
            (float(m.get("tMin") or 0) - decided_at for m in (situation.summary or {}).get("milestones") or []
             if decided_at < float(m.get("tMin") or 0) <= decided_at + until and float(m.get("maxIntensityKwm") or 0) >= full),
            default=None,
        )
        if crown_at is None:
            return False
        try:
            start = situation.anchor
        except ValueError:
            return False
        # Get active sectors at the current decision time directly on the active fire front
        current_sectors: list[Sector] = []
        try:
            vectors = self.client.get_vectors(situation.simulation_id, t_min=int(round(decided_at)))
            current_sectors = plan_sectors(vectors, zone_radius_m=situation.zone_radius_m, all_around=True)
        except ApiProblem:
            current_sectors = []

        if not current_sectors:
            head_lat, head_lon = float(start["lat"]), float(start["lon"])
            current_sectors = [Sector(head_lat, head_lon, situation.head_bearing_deg, situation.head_speed_mmin, situation.max_intensity_kwm)]

        planner = TravelPlanner(self.client, location_id=str(self._location_id), simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules,
                                cache=self._routes, avoid_fire=False, origins=self.origins)
        early = sum(1 for a in aircraft if (planner.eta(a, start).arrival_minutes or math.inf) <= crown_at)
        # the aircraft drop on the edge the fire has when they get there (the decision's picture is minutes old by then, and a young fire's only stretch is a point
        # it leaves at once), and only where water still stops it: a drop on a stretch burning past noEffectFromKwm does nothing (the backend fades direct attack,
        # drops included, to zero there), so with the head past it they hold the flanks and the back
        workable = self._air_workable(situation, decided_at + self._air_lead(aircraft, start, planner))
        if workable:
            current_sectors = workable

        # Distribute aircraft across active fire sectors (max 2 per sector, with staggered rotation timing)
        num_sectors = len(current_sectors)
        for idx, agent in enumerate(aircraft):
            sector_idx = (idx // 2) % num_sectors if num_sectors > 1 else 0
            sector = current_sectors[sector_idx]
            slot = idx % 2
            stagger = (idx % 2) * 3.0 + (idx // (2 * num_sectors)) * 6.0
            site = {"lat": sector.lat, "lon": sector.lon}
            line = line_across(sector.lat, sector.lon, sector.bearing_deg, situation.zone_radius_m, slot)
            result.assignments[agent.agent_id] = replace(
                result.assignments[agent.agent_id],
                sector=sector,
                site=site,
                air_line=line,
                air_corridor=None,
                air_until=float(until),
                start_after=stagger if stagger > 0 else None,
                slot=slot,
            )

        result.issues.append(AgentIssue("orchestrator", "ataque aéreo inicial", (
            f"the fire passes {full:.0f} kW/m at T+{crown_at:.0f}, before the bulk of the crews (T+{until:.0f}): {len(aircraft)} aircraft ({early} overhead before T+{crown_at:.0f}) "
            f"distributed across {min(len(aircraft), num_sectors)} sectors on the active fire perimeter.")))
        return True

    def _hold_reserve(self, result: CycleResult, share: float) -> list[str]:
        """Keep ``share`` of the combat units at their stations as a tactical reserve: the ones that would arrive last (a commander sends the nearest first).

        They are in no action, so the re-plans along the fire can send them where the fire goes (see ``adaptation.py``).
        """
        combat = [
            a for a in self.agents
            if a.tier is not FirefighterTier.HELICOPTER and a.agent_id not in result.unsafe_units
            and (assignment := result.assignments.get(a.agent_id)) is not None and assignment.place is None
        ]
        count = int(round(share * len(combat)))
        # never at the expense of the attack: when the fire can be attacked, only the units the outline has no room for are held back
        spare = [a for a in combat if result.assignments[a.agent_id].reserve] if result.initial_attack else combat
        spare.sort(key=lambda a: self._arrival.get(a.agent_id, float("inf")), reverse=True)
        return [a.agent_id for a in spare[:count]]

    def _fit_on_outline(self, situation: Situation, result: CycleResult, groups: list[tuple[set[str], float]] | None = None) -> tuple[int, int]:
        """Put the crews on the fire's outline, as many as it has room for, and no more than the rules let one piece of ground use.

        The backend multiplies the effect of every crew on the same ground without limit, but its own rules cap what a crew can do at
        ``maxEffectiveness``: a planner should not count on more than that from one zone. So crews fill a zone until together they reach
        that cap, then the next zone along the outline; the outline has ``perimeter / (2 × zone radius)`` zones. Crews left over are in
        reserve (``Assignment.reserve``): they block ahead of the fire as they would without an initial attack.
        A stretch of front burning past ``noEffectFromKwm`` when its crews arrive cannot be attacked head-on: those crews are in reserve too.
        Returns (zones available, crews put on them).
        """
        rules = situation.rules or {}
        cap = float(((rules.get("suppression") or {}).get("maxEffectiveness")) or 0.85)
        limit = float(((rules.get("suppression") or {}).get("noEffectFromKwm")) or DEFAULT_NO_EFFECT_KWM)
        decided_at = float(situation.at_minute if situation.at_minute is not None else (situation.latest_milestone.get("tMin") or 0))
        total_zones = on_outline = 0
        for ids, lead in groups or [(None, result.attack_lead or 0.0)]:
            crews = [
                a for a in self.agents
                if a.tier is not FirefighterTier.HELICOPTER and a.agent_id in result.assignments and result.assignments[a.agent_id].place is None and result.assignments[a.agent_id].stay_minutes != 0 and (ids is None or a.agent_id in ids)
            ]
            for agent in [a for a in crews if (s := result.assignments[a.agent_id].sector) is not None and s.intensity_kwm >= limit]:
                result.assignments[agent.agent_id] = replace(result.assignments[agent.agent_id], reserve=True)  # too intense to attack head-on: it works ahead
                crews.remove(agent)
            zones = self._outline_zones(situation, int(round(decided_at + lead)))
            total_zones += zones
            by_sector: dict[Any, list[FirefighterAgent]] = {}
            for agent in sorted(crews, key=lambda a: (a.tier is not FirefighterTier.TRUCK, a.agent_id)):  # engines first: they bring the water
                by_sector.setdefault(result.assignments[agent.agent_id].sector, []).append(agent)
            per_sector = max(1, math.ceil(zones / max(len(by_sector), 1)))
            # the zone index runs along the whole outline, not per sector: otherwise the first zone of every sector is "slot 0" and all of them stack on one point
            next_zone = 0
            for sector_crews in by_sector.values():
                zone, survive, first = 0, 1.0, next_zone
                for agent in sector_crews:
                    if 1.0 - survive >= cap:  # this zone is as strong as the rules allow: next one along the outline
                        zone, survive = zone + 1, 1.0
                    if zone >= per_sector:
                        result.assignments[agent.agent_id] = replace(result.assignments[agent.agent_id], reserve=True)
                        continue
                    survive *= 1.0 - situation.suppression_effectiveness(agent.observation.crew_onboard, agent.observation.water_capacity_l)
                    result.assignments[agent.agent_id] = replace(result.assignments[agent.agent_id], slot=first + zone, reserve=False)
                    on_outline += 1
                next_zone = first + zone + 1
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
        ahead = decided_at + (round(lead) if lead is not None else min(situation.horizon_minutes, FRONT_LOOKAHEAD_MIN))  # where the fire will be when the crews are there, not an hour on
        instants = [min(ahead, duration) if duration else ahead, decided_at]
        sectors: list[Sector] = []
        for t_min in dict.fromkeys(instants):
            try:
                vectors = self.client.get_vectors(situation.simulation_id, t_min=int(t_min))
            except ApiProblem:  # a server without vectors: units fall back to the fire's head
                continue
            workability = self._sector_workability(situation)
            sectors = plan_sectors(vectors, zone_radius_m=situation.zone_radius_m, workability_of=workability)
            if sectors:
                sectors = self._with_outline(situation, sectors, int(t_min), workability)
                break
        fighters = [agent for agent in self.agents if agent.agent_id not in exclude]
        units = [(agent.agent_id, agent.tier.value) for agent in fighters]
        budgets = (
            {a.agent_id: line_budget_m(a.tier.value, a.observation.crew_onboard, stage_minutes, situation.rules) for a in fighters}
            if stage_minutes
            else None
        )
        # places are not dealt out here: the life planner decides who looks after whom (see `_plan_life`)
        no_effect = float(((situation.rules or {}).get("suppression") or {}).get("noEffectFromKwm") or DEFAULT_NO_EFFECT_KWM)
        assigned = assign_units(units, sectors, [], budgets=budgets, concentration=concentration, need_m_of=lambda s: front_need_m(situation.zone_radius_m, s.intensity_kwm, no_effect),
                                rank=self._arrival)  # the nearest units take the front; the farthest are the ones left over
        return self._advised_sectors(assigned, fighters, units, sectors, situation, budgets, concentration)

    def _with_outline(self, situation: Situation, sectors: list[Sector], minute: int, workability: Callable[[Sector], float] | None = None) -> list[Sector]:
        """The vectors' stretches plus the flanks and back the vectors miss (``outline_sectors``), most dangerous first.

        Without them a young fire was one sector, its head: past direct attack, so the units that got there first had nothing to do and waited kilometres
        away while units an hour and a half out took the flanks later.
        """
        if not sectors or minute <= 0:
            return sectors
        try:
            perimeters = self.client.get_perimeters(situation.simulation_id, t_min=minute)
        except ApiProblem:
            return sectors
        added = outline_sectors(perimeters, situation.ignition, sectors, near_m=situation.zone_radius_m / 2.0, workability_of=workability)
        return sorted([*sectors, *added], key=lambda s: s.danger, reverse=True) if added else sectors

    def _sector_workability(self, situation: Situation) -> Callable[[Sector], float] | None:
        """How workable the ground of a front stretch is for a crew on foot (``terrain.py``), or ``None`` when terrain is off or the location unknown."""
        reader = self._terrain_reader(self._location_id) if self._location_id else None
        if reader is None:
            return None

        def workability(sector: Sector) -> float:
            assessment = reader.assess(sector.position, head_bearing_deg=sector.bearing_deg, tier="squad")
            return assessment.factor if assessment is not None else 1.0  # ground the backend cannot describe is not penalised

        return workability

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

    def _plan_life(self, situation: Situation, location_id: str, assignments: dict[str, Assignment], exclude: set[str] = frozenset(),  # type: ignore[assignment]
                   zones: Sequence[BuildingZone] = ()) -> LifePlan | None:
        """Decide who evacuates what (vulnerable and most urgent first) and who shelters; hands each place its units.

        Squads (and vehicles that carry passengers) evacuate; fire engines able to defend buildings defend the threatened places.
        Everyone else keeps fighting the fire.
        """
        from dataclasses import replace  # local: only this method rewrites assignments

        assets = situation.people_in_danger_within(situation.life_horizon_minutes)
        now = float(situation.at_minute or 0)
        items = []
        # the houses in the fire's way that belong to no named place (`/threatened` only names places): their people are evacuated or told to shelter too
        for index, zone in enumerate(zones):
            if zone.people <= 0:
                continue
            asset = zone.asset(index)
            items.append(AtRisk(
                id=asset["id"], name=f"casas isoladas ({zone.buildings} edifícios)", kind="building_zone", position=asset["position"], people=zone.people, vulnerable=False,
                arrival_p10=now + zone.arrival_min, arrival_p50=now + zone.arrival_min, people_source="buildings", asset=asset,
            ))
        if not assets and not items:
            return None
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
        margin = float((((situation.rules or {}).get("safety") or {}).get("withdrawWhenFireArrivesInMinutes")) or 15.0)
        plan = plan_life(items, evacuators, now=now, margin_min=margin, order=self._advised_evacuation_order(items, len(evacuators), now, margin))
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
        self, situation: Situation, location_id: str, max_zones: int, stage_minutes: int | None, result: CycleResult, *, whole_run: bool = False, per_zone: int = DEFENDERS_PER_ZONE
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
        # Every patch of houses the forecast fire reaches within the life horizon is prepared, whether or not the fire may still be put out: a commander does not
        # bet the houses on the attack working (structure triage, DECIR), and the engines prepare and leave before the fire arrives (`_place_safely`). Defending
        # only what burns before the crews could stop it left the plan with no house defended at all on a fire whose first house burns 75 min out.
        window = max(stage_minutes or situation.horizon_minutes, situation.life_horizon_minutes)
        if whole_run and self._run_minutes:  # plan B: every patch of houses the forecast fire reaches in the whole run, whether the fire can be attacked or not
            window = max(window, self._run_minutes - int(decided_at))
        zones = zones_to_defend(
            cells, ignition, after_min=decided_at, until_min=decided_at + window, radius_m=HOUSE_ZONE_RADIUS_M,  # the houses of one patch: a house-sized disc, not a work zone
            max_zones=min(max_zones, max(1, len(engines) // per_zone)),
        )
        reserved: dict[str, dict[str, Any]] = {}
        for index, zone in enumerate(zones):
            for agent in engines[index * per_zone:(index + 1) * per_zone]:
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
                "area": zone_around(float(item.position["lat"]), float(item.position["lon"]), 0.0, 150.0, 0, 16),  # the place's houses, not a 500 m disc
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
        """The GNR's part: seal off the zone the fire reaches until the end of the simulation, one patrol at every access into it (see ``gnr.py``).

        Not only the next hour: an access is closed *before* the fire reaches the roads behind it (the action's trigger is that cut minus a lead), so the
        plan names them all. The most urgent get the patrols, which are few.
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
        horizon = max(float(duration) - decided_at, float(situation.horizon_minutes)) if duration else float(situation.life_horizon_minutes)
        plan.closures = plan_cordon(statuses, self._roads[location_id], decided_at=decided_at, horizon=horizon, intensity_at=intensity_lookup(situation.summary))
        # a vehicle already fighting the fire (the GNR's all-terrain patrols also attack it) is not sent to a road as well
        fighting = {str(r.get("resourceId")) for message in result.decisions for proposal in message.proposals for r in proposal.resources}
        units = [u for u in units if str(u["id"]) not in fighting]
        plan.closures = self._advised_closures(plan.closures, len(units), result, decided_at)
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes)
        stations = {u["stationId"]: planner.station_position(u["stationId"]) for u in units if u.get("stationId")}
        stations = {sid: pos for sid, pos in stations.items() if pos}
        taken: set[str] = set()
        kept: list[Any] = []
        for closure in plan.closures:
            # a patrol is worth sending only if it is there before the fire cuts the road (or, if the fire has cut it, while it stays cut). An access into the
            # fire zone is the exception: a patrol that gets there after the fire reaches the roads behind it still stops people driving into it, so it goes as
            # long as the roads stay cut (the closure starts when it arrives, and the plan says it is late)
            if closure.already_cut(decided_at) or closure.access:
                deadline = closure.reopen_p50 - decided_at - (0.0 if closure.access else closure.lead_minutes)
            else:
                deadline = closure.cut_p10 - decided_at
            patrols: list[tuple[dict[str, Any], Any]] = []
            missing: str | None = None
            for end_index, end in enumerate(closure.ends):
                chosen: tuple[dict[str, Any], Any] | None = None
                late = False
                for vehicle in nearest_units(units, stations, end, taken | {str(v["id"]) for v, _r in patrols}):
                    route = planner.eta(unit_stub(vehicle), end) if travel else None
                    if route is not None and not route.reachable:
                        continue
                    if route is not None and route.eta_minutes is not None and route.eta_minutes > deadline:
                        late = True
                        continue
                    chosen = (vehicle, route)
                    break
                if chosen is None:
                    missing = "nenhuma patrulha da GNR livre chega lá a tempo" if late else "nenhuma patrulha da GNR livre o alcança"
                    break
                patrols.append(chosen)
            if missing is not None:
                # drivers only know a road is closed if someone stands where they come in: an access without its patrol is open
                plan.issues.append(f"acesso por {closure.name} (T+{closure.cut_p10:.0f}): fica aberto: {missing}")
                continue
            index = len(kept)
            kept.append(closure)
            taken.update(str(v["id"]) for v, _r in patrols)
            # the road is closed from the moment the last patrol is there (never before), and not later than planned
            arrivals = [float(r.eta_minutes) for _v, r in patrols if r is not None and r.eta_minutes is not None]
            planned = 0.0 if closure.already_cut(decided_at) else max(closure.cut_p10 - decided_at - closure.lead_minutes, 0.0)
            opens = max([planned, *arrivals])
            if closure.access and not closure.already_cut(decided_at) and decided_at + opens > closure.cut_p10:
                plan.issues.append(f"acesso por {closure.name}: a patrulha chega às T+{decided_at + opens:.0f}, depois de o fogo chegar às estradas para lá dele (T+{closure.cut_p10:.0f}); fecha logo que chega")
            checkpoints: list[dict[str, Any]] = []
            points: list[dict[str, Any]] = []
            for end_index, (vehicle, route) in enumerate(patrols):
                end = closure.ends[end_index]
                resource: dict[str, Any] = {"resourceType": "vehicle", "resourceId": vehicle["id"], "personnel": int(vehicle.get("crewCapacity") or CHECKPOINT_PERSONNEL), "responsibility": "traffic_control"}
                eta = float(route.eta_minutes) if route is not None and route.eta_minutes is not None else 0.0
                if route is not None and route.eta_minutes is not None:
                    resource["etaMinutes"] = round(eta, 1)
                    resource["fromStationId"] = route.from_station
                checkpoints.append({"position": end, "label": f"Acesso por {closure.name}", "organizationId": organization, "personnel": resource["personnel"], "vehicles": 1})
                # the patrol stays at its access as long as the road is closed (until the fire has passed and it reopens, or to the end of the run)
                closed_until = (closure.reopen_p90 - decided_at) if math.isfinite(closure.reopen_p90) else (float(self._run_minutes or 720) - decided_at)
                points.append(control_point_action(closure, index, end_index, organization, decided_at, resource, leaves=max(opens - eta, 0.0),
                                                   stay=max(closed_until - opens, 30.0)))
            plan.actions.append(closure_action(closure, index, organization, decided_at, checkpoints, opens=opens))
            plan.actions.extend(points)
        plan.closures = kept
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
            origins=self.origins,
        )
        agents = {agent.agent_id: agent for agent in self.agents}
        decided_at = float(situation.at_minute or 0)
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
                if (clock := self._clocks.get(situation.simulation_id)) is not None and route.geometry:
                    # the drive must not cross ground that is burning when the unit passes: look for a road that does not, else the unit waits for the next decision
                    hit = route_in_fire(clock, route.geometry, decided_at + route.delay_minutes, route.eta_minutes or 0.0)
                    if hit is not None:
                        safer = self._safe_planner(planner, location_id, situation).eta(agent, target)
                        if safer.reachable and safer.geometry and route_in_fire(clock, safer.geometry, decided_at + safer.delay_minutes, safer.eta_minutes or 0.0) is None:
                            route = safer
                        else:
                            result.issues.append(AgentIssue(agent_id, proposal.title, f"dropped: its road crosses ground that is burning when it passes (T+{hit:.0f} min) and there is no other way."))
                            dropped.add(proposal.proposal_id)
                            lost.setdefault(agent_id, (agent, "a estrada atravessa o fogo", target))
                            continue
                proposal.eta_minutes, proposal.from_station, proposal.route = route.eta_minutes, route.from_station, route.geometry
                if route.geometry:
                    self.unit_routes[str(agent.observation.vehicle_id or agent_id)] = route.geometry  # the road each unit takes to its job: where it can wait afterwards (holding.py)
                proposal.delay_minutes = route.delay_minutes
                arrives = decided_at + route.delay_minutes + (route.eta_minutes or 0.0)
                if self._run_minutes and proposal.intervention.get("type") in COMBAT_EFFECTS and arrives > self._run_minutes - MIN_USEFUL_WORK_MIN:
                    # a reinforcement that gets there when the run is all but over does nothing in it: it stays free instead of filling the plan
                    result.issues.append(AgentIssue(agent_id, proposal.title, f"not sent: it would arrive at T+{arrives:.0f}, with under {MIN_USEFUL_WORK_MIN} min of the run left to work."))
                    dropped.add(proposal.proposal_id)
                    continue
                if proposal.intervention.get("type") == "aerial_drop" and self._sunset is not None and arrives > self._sunset - AIR_MIN_DAYLIGHT_MIN:
                    # firefighting aircraft fly by day only (AerialSpec.dayOnly): one that would get there at dusk is not sent
                    result.issues.append(AgentIssue(agent_id, proposal.title, f"not sent: it would arrive at T+{arrives:.0f}, with the sun setting at T+{self._sunset:.0f} (aircraft fly by day only)."))
                    dropped.add(proposal.proposal_id)
                    continue
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

    def _stage(self, lost: dict[str, tuple[FirefighterAgent, str, dict[str, Any]]], situation: Situation, location_id: str, result: CycleResult, *, reserve: bool = False) -> list[dict[str, Any]]:
        """Units that cannot reach the fire do not vanish: they go as near as is safe and wait there (a ``stage_resources`` action per organization).

        The point is on the line from the fire to the unit's station, as near to the fire as the routing says the unit can get while avoiding the predicted
        fire (300 and 500 m, then 0.8, 1.6, 3.2 and 6.4 km out), and where the forecast fire never gets during the run. The unit does nothing there: the plan says so, and why.
        ``reserve``: these are plan B's forward reserve, held close to the fire to go in at the next decision (or to a new outbreak) within minutes.
        """
        if not lost:
            return []
        clock = self._clocks.get(situation.simulation_id)
        run_minutes = self._run_minutes or situation.life_horizon_minutes + int(situation.at_minute or 0)
        planner = TravelPlanner(self.client, location_id=location_id, simulation_id=situation.simulation_id, at=situation.snapshot_time, rules=situation.rules, cache=self._routes, avoid_fire=True, origins=self.origins)
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
                    if (clock is None or clock.safe(lat, lon, 0, run_minutes)) and planner.eta(first, {"lat": lat, "lon": lon}).reachable
                ),
                None,
            )
            if spot is None:
                result.issues.append(AgentIssue("orchestrator", "staging", f"no safe waiting point found for {len(group)} unit(s) of {organization}."))
                continue
            resources: list[dict[str, Any]] = []
            delays: list[float] = []
            for agent, _r, _t in group:
                travel = planner.eta(agent, spot)
                delays.append(travel.delay_minutes)
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
            km = distance_m(float(anchor["lat"]), float(anchor["lon"]), spot["lat"], spot["lon"]) / 1000
            actions.append({
                "id": f"{'reserve' if reserve else 'stage'}-{index}",
                "type": "stage_resources",
                "title": f"{'Reserva avançada' if reserve else 'Pré-posicionar'}: {len(resources)} meios a {km:.1f} km do fogo",
                "organizationId": organization,
                "priority": "high",
                "rationale": (
                    f"Reserva avançada: {len(resources)} meios esperam a {km:.1f} km do fogo, num ponto que o fogo previsto não atinge, prontos a entrar em minutos na "
                    "próxima reavaliação, onde o fogo mudar, ou num novo foco."
                    if reserve else
                    f"Estas unidades não chegam ao fogo ({', '.join(reasons)}): vão até ao ponto mais próximo a que chegam com segurança e esperam aí, prontas a avançar."
                ),
                "stagingArea": {"position": spot, "label": "Reserva avançada" if reserve else "Ponto de espera"},
                "readiness": "engine_running",
                "resources": resources,
                # reinforcements set off once they reach the municipality
                **({"trigger": {"kind": "at_time", "at": {"offsetMinutes": int(math.ceil(min(delays)))}}} if delays and min(delays) > 0 else {}),
            })
        return actions

    # -- the advisor: an LLM commander that chooses among the options the rules offer -------
    def _begin_advice(self, use_advisor: bool) -> None:
        self._advising = bool(use_advisor) and self.advisor.name != "rules"
        self._advice = AdvisorLog(advisor=self.advisor.name if self._advising else "rules")
        self._advice_calls = 0

    def _ask_advisor(self, method: str, brief: dict[str, Any]) -> Any:
        """Ask the advisor one question. Whatever it raises, the cycle goes on with the rules: a commander that fails must not cost the plan."""
        try:
            return getattr(self.advisor, method)(brief)
        except Exception as error:  # noqa: BLE001 — an advisor is a guest; its failure is logged and the rules decide
            log.warning("advisor %s failed on %s: %s: %s", self.advisor.name, method, type(error).__name__, str(error)[:200])
            self._advice.discarded.append(f"{method}: o comando falhou ({type(error).__name__})")
            return None

    def _note_advice(self, applied: str | None = None, discarded: list[str] | None = None) -> None:
        """Keep what the advisor said (its reasons) and what became of its choices: taken, or thrown away and why."""
        self._advice.notes.extend(self.advisor.drain_notes())
        if applied:
            self._advice.applied.append(applied)
        self._advice.discarded.extend(discarded or [])

    def _advised_sectors(
        self, assigned: dict[str, Assignment], fighters: list[Any], units: list[tuple[str, str]], sectors: list[Sector], situation: Situation,
        budgets: dict[str, float] | None, concentration: int | None,
    ) -> dict[str, Assignment]:
        """The units' sectors as the commander sees them fit (Bombeiros): it is shown the front, the ground on each stretch and every unit, and the rules' own assignment."""
        if not self._advising or not sectors or not fighters or self._advice_calls >= MAX_ADVICE_SECTOR_CALLS:
            return assigned
        self._advice_calls += 1
        reader = self._terrain_reader(self._location_id) if self._location_id else None
        index_of = {id(sector): i for i, sector in enumerate(sectors)}
        brief = {
            "decidedAtMin": situation.at_minute, "initialAttack": bool(getattr(situation, "initial_attack", False)),
            "sectors": sector_brief(sectors, lambda sector: reader.assess(sector.position, head_bearing_deg=sector.bearing_deg, tier="squad") if reader else None),
            "units": [unit_brief(agent, self._arrival.get(agent.agent_id), None) for agent in fighters],
            "rulesAssignment": {agent_id: sector_id(index_of[id(a.sector)]) for agent_id, a in assigned.items() if a.sector is not None and id(a.sector) in index_of},
        }
        choice, problems = valid_sector_choice(self._ask_advisor("assign_sectors", brief), (a for a, _t in units), (sector_id(i) for i in range(len(sectors))))
        by_id = {sector_id(i): i for i in range(len(sectors))}
        preferred = {unit: by_id[sector] for unit, sector in choice.items() if assigned.get(unit) is None or assigned[unit].sector is not sectors[by_id[sector]]}
        if preferred:
            assigned = with_preferences(assigned, units, sectors, preferred, budgets=budgets, concentration=concentration)
        self._note_advice(f"setores: {len(preferred)} unidade(s) mudadas de setor" if preferred else None, problems)
        return assigned

    def _advised_evacuation_order(self, items: list[Any], evacuators: int, now: float, margin: float) -> list[str] | None:
        """The order the places are evacuated in (Proteção Civil), when a commander weighs them differently from "vulnerable first, then the soonest"."""
        if not self._advising or len(items) < 2:
            return None
        places = evacuation_brief(items, now, margin)
        asked = self._ask_advisor("order_evacuations", {"places": places, "evacuatorsAvailable": evacuators, "decidedAtMin": now})
        if asked is None:  # no opinion: not a mistake to record
            self._note_advice()
            return None
        order, problems = valid_evacuation_order(asked, places)
        self._note_advice("evacuações: ordem escolhida pelo comando" if order else None, problems)
        return order

    def _advised_shelters(self, agents: SupportAgents | None, plan: dict[str, Any], people: dict[str, tuple[int, bool, str]]) -> dict[str, str] | None:
        """The shelter each evacuation goes to (Proteção Civil), among the ones that are far enough and that the fire does not reach in time."""
        if not self._advising or agents is None:
            return None
        choices = agents.evacuation_choices(plan, people)
        if not choices:
            return None
        options = {c["placeId"]: [o["id"] for o in c["options"]] for c in choices}
        chosen, problems = valid_shelters(self._ask_advisor("choose_shelters", {"evacuations": choices}), options)
        by_place = {c["placeId"]: c for c in choices}
        # the choice is keyed by the place id the advisor saw; the support code looks a shelter up by any of the action's place ids
        mapped = {pid: shelter for place, shelter in chosen.items() for pid in by_place[place]["placeIds"] or [place]}
        self._note_advice(f"abrigos: {len(chosen)} escolha(s) do comando" if chosen else None, problems)
        return mapped or None

    def _advised_closures(self, closures: list[Any], patrols: int, result: CycleResult, decided_at: float) -> list[Any]:
        """In what order the (few) patrols are committed to the accesses (GNR). Every access stays in the plan: one the commander leaves out goes last, never away
        (a cordon with a gap in it is no cordon)."""
        if not self._advising or len(closures) < 2:
            return closures
        ids = {f"C{i + 1}": closure for i, closure in enumerate(closures)}
        places = [d.item for d in (result.life.decisions if result.life else ())]

        def near(closure: Any) -> list[str]:
            return sorted({p.name for p in places for end in closure.ends if p.position and distance_m(end["lat"], end["lon"], float(p.position["lat"]), float(p.position["lon"])) <= 2000.0})[:4]

        brief = {"decidedAtMin": decided_at, "patrolsAvailable": patrols, "closures": [{
            "id": cid, "road": closure.name, "class": closure.road_class, "lengthM": round(closure.length_m), "alreadyCut": closure.already_cut(decided_at),
            "fireCutsAtMin": {"pessimistic": round(closure.cut_p10), "likely": round(closure.cut_p50)}, "reopensAtMin": round(closure.reopen_p50),
            "probability": round(closure.probability, 2), "intensityKwM": round(closure.max_intensity_kwm), "nearThreatenedPlaces": near(closure),
        } for cid, closure in ids.items()]}
        order = self._ask_advisor("order_closures", brief)
        if order is None:
            self._note_advice()
            return closures
        kept, problems = valid_closures(order, ids)
        if not kept:
            self._note_advice(discarded=[*problems, "o comando não manteve nenhum corte: ficam os das regras"])
            return closures
        left_out = [cid for cid in ids if cid not in kept]
        self._note_advice(f"acessos: ordem das patrulhas escolhida pelo comando ({len(kept)} de {len(ids)} ordenados; os restantes a seguir)", problems)
        return [ids[cid] for cid in [*kept, *left_out]]

    def _advised_standby(self, agents: SupportAgents, sites: list[dict[str, float]], head_bearing: float, ambulances: list[dict[str, Any]]) -> dict[str, Any] | None:
        """Where the ambulances wait and how many (INEM), among the distances behind the crews that the fire never reaches."""
        if not self._advising or not sites or not ambulances:
            return None
        _middle, options = agents.standby_options(sites, head_bearing)
        if len(options) < 2 and len(ambulances) < 2:
            return None
        distances = [d for d, _spot in options]
        brief = {"safeDistancesBehindCrewsM": distances, "ambulancesAvailable": len(ambulances), "defaultAmbulances": STANDBY_AMBULANCES, "crewSites": len(sites),
                 "hospitals": [{"name": f.get("name"), "distanceKm": round(distance_m(_middle["lat"], _middle["lon"], f["position"]["lat"], f["position"]["lon"]) / 1000, 1)}
                               for f in sorted((f for f in agents.facilities if f.get("kind") == "hospital" and f.get("position")), key=lambda f: distance_m(_middle["lat"], _middle["lon"], f["position"]["lat"], f["position"]["lon"]))[:3]] if _middle else []}
        asked = self._ask_advisor("choose_standby", brief)
        if asked is None:  # no opinion
            self._note_advice()
            return None
        choice, problems = valid_standby(asked, distances, len(ambulances))
        self._note_advice(f"INEM: prevenção a {choice['backM']:.0f} m, {choice['ambulances']} ambulância(s)" if choice else None, problems)
        return choice

    def _advised_review(self, result: CycleResult, plan: dict[str, Any], situation: Situation) -> None:
        """A commander's last look at the plan's picture (a note for the operator; it changes nothing)."""
        if not self._advising:
            return
        actions = plan.get("actions", [])
        by_type: dict[str, int] = {}
        for action in actions:
            by_type[str(action.get("type"))] = by_type.get(str(action.get("type")), 0) + 1
        brief = {
            "assessment": result.assessment(self._load_rules()), "actionsByType": by_type, "unitsCommitted": len(result.decisions), "unitsHeld": len(result.held), "unitsWithoutSafeSpot": len(result.unsafe_units),
            "evacuations": [d.reason for d in (result.life.decisions if result.life else ())][:6], "closures": len(result.traffic.closures) if result.traffic else 0,
            "actionsOnDifficultGround": sum(1 for a in actions if "Terreno:" in (a.get("safetyNotes") or "")),
            "issues": [f"{i.agent_id}: {i.problem}" for i in result.issues][:8],
            "advisorDecisions": list(self._advice.applied),
        }
        self._advice.review = self._ask_advisor("review", brief)
        self._note_advice()

    # -- the ground and the water where a crew works ---------------------------------
    def _terrain_reader(self, location_id: str) -> TerrainReader | None:
        if not self.terrain_enabled:
            return None
        if location_id not in self._terrain:
            self._terrain[location_id] = TerrainReader(self.client, location_id)
        return self._terrain[location_id]

    def _terrain_effect(self, location_id: str, intervention: dict[str, Any], site: dict[str, float] | None, unit: Any, situation: Situation) -> str:
        """Scale a ground crew's effect by how workable its ground is (slope, fuel, the fire running uphill, distance to a road: ``terrain.py``), and say so.

        The backend slows a *road trip* on a slope but not a crew working on one, so this is where "fighting fire on a steep slope is hard" enters the plan.
        Returns the note for the action's ``safetyNotes`` ('' when the ground is easy, unknown, or the unit flies).
        """
        reader = self._terrain_reader(location_id)
        tier = getattr(getattr(unit, "tier", None), "value", "")
        if reader is None or tier not in {"squad", "truck"} or intervention.get("type") not in {"crew_deployment", "fire_line", "fuel_removal"}:
            return ""
        assessment = reader.assess(site, head_bearing_deg=situation.head_bearing_deg, tier=tier)
        if assessment is None:
            return ""
        return assessment.note(applied=apply_terrain_effect(intervention, assessment))

    def _refill_gap(self, location_id: str, site: dict[str, float] | None, unit: Any, situation: Situation) -> float | None:
        """Minutes an engine at ``site`` is away on each refill, from the real drive to water (``None``: use the backend's generic shuttle)."""
        reader = self._terrain_reader(location_id) if self.real_refill else None
        if reader is None or getattr(getattr(unit, "tier", None), "value", "") != "truck":
            return None
        return reader.refill_gap_minutes(site, setup_minutes=refill_setup_minutes(situation.rules), water_l=float(unit.observation.water_capacity_l or 0.0), rules=situation.rules)

    def _refill_note(self, location_id: str, site: dict[str, float] | None, unit: Any, situation: Situation) -> str | None:
        """Where an engine refills and how long each refill keeps it away, for the plan (``ResourceAssignment.notes``)."""
        reader = self._terrain_reader(location_id) if self.real_refill else None
        if reader is None or getattr(getattr(unit, "tier", None), "value", "") != "truck" or not unit.observation.water_capacity_l:
            return None
        source = reader.refill_source(site, situation.rules)
        if source is None:
            return "Sem ponto de água conhecido por estrada: reabastece com o vaivém genérico das regras."
        return source.note(float(unit.observation.water_capacity_l), refill_setup_minutes(situation.rules))

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
        agents_by_id = {agent.agent_id: agent for agent in self.agents}
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
            depart = proposal.delay_minutes
            if proposal.eta_minutes is not None and isinstance(intervention.get("start"), dict):
                # nothing works before the unit is there: the backend applies the effect from its `start`, and a missing ETA would put crews on the fire at once
                begin = intervention["start"].get("offsetMinutes") or 0
                intervention["start"] = {**intervention["start"], "offsetMinutes": max(begin, math.ceil(proposal.delay_minutes + proposal.eta_minutes))}
                if proposal.action_type in ("fire_attack", "structure_protection") and begin > proposal.delay_minutes + proposal.eta_minutes + 1:
                    # its work starts later (it is timed to the fire's arrival): it sets off then, instead of waiting on the spot where nothing burns yet
                    depart = max(proposal.delay_minutes, begin - proposal.eta_minutes)
            if depart and "trigger" not in action:
                # a reinforcement sets off from its entry point when it gets there, a unit timed to the fire when it is needed: the backend times its departure
                # (and its track on the map) from the trigger
                action["trigger"] = {"kind": "at_time", "at": {"offsetMinutes": int(math.ceil(depart))}}
            decided_at = int(situation.at_minute or 0)
            if decided_at:
                # the backend honours `start`: offsets count from the scenario start, so a decision taken at T+N begins at N (+ its own delay)
                for key in ("start", "completeBy"):
                    spec = intervention.get(key)
                    if isinstance(spec, dict) and "offsetMinutes" in spec:
                        intervention[key] = {**spec, "offsetMinutes": spec["offsetMinutes"] + decided_at}
            action["simulationEffects"] = [intervention]
            action.update({key: value for key, value in proposal.extra_action_fields.items() if value is not None})
            unit = agents_by_id.get(message.agent_id)
            work_site = proposal.target or centroid(intervention.get("geometry"))
            if unit is not None and intervention.get("type") == "crew_deployment" and intervention.get("responsibility") == "firefighting" and intervention.get("durationMinutes"):
                # water, refills, fatigue and rest, as the backend counts them (`duty.py`): the crew's strength averaged over its window
                action.setdefault("expectedDurationMinutes", int(intervention["durationMinutes"]))
                strength = float(intervention.get("effectiveness") or situation.suppression_effectiveness(int(intervention.get("personnel") or unit.observation.crew_onboard), float(intervention.get("waterL") or 0.0)))
                gap = self._refill_gap(location_id, work_site, unit, situation)
                source = self._terrain_reader(location_id).refill_source(work_site, situation.rules) if self.real_refill and gap is not None else None
                fuel = fuel_of(situation.rules, water_trip_drive_minutes=source.drive_minutes if source else None) if getattr(getattr(unit, "tier", None), "value", "") == "truck" else None
                factor = duty_factor(float(intervention["durationMinutes"]), unit.observation.water_capacity_l, unit.observation.pump_lpm, situation.rules, gap, fuel)
                intervention["effectiveness"] = round(max(0.01, min(1.0, strength * factor)), 2)
            if unit is not None and intervention.get("type") in {"crew_deployment", "fire_line"} and (note := self._refill_note(location_id, work_site, unit, situation)):
                # where the engine fills up, by road, and how long each refill keeps it away (the backend's unit simulator drives that same trip on the map)
                for resource in action.get("resources") or []:
                    if resource.get("resourceType") == "vehicle":
                        resource["notes"] = f"{resource['notes']} {note}".strip() if resource.get("notes") else note
            if unit is not None and (note := self._terrain_effect(location_id, intervention, work_site, unit, situation)):
                action["safetyNotes"] = f"{action['safetyNotes']} {note}".strip() if action.get("safetyNotes") else note
            if unit is not None and intervention.get("type") == "aerial_drop" and intervention.get("effectDurationMinutes"):
                # an aircraft drops, flies to refill and comes back: its effect is weighed by how much of each rotation a drop keeps the ground wet,
                # and it ends at sunset (it flies by day only)
                rotation, water_km = self._air_rotation(unit, proposal.target or centroid(intervention.get("geometry")), situation)
                factor = min(1.0, AIR_DROP_WET_MIN / rotation) if rotation > 0 else 1.0
                intervention["effectiveness"] = round(max(0.05, float(intervention.get("effectiveness") or 0.5) * factor), 2)
                begins = float((intervention.get("start") or {}).get("offsetMinutes") or 0)
                if self._sunset is not None:
                    intervention["effectDurationMinutes"] = int(max(1, min(float(intervention["effectDurationMinutes"]), self._sunset - begins)))
                action.setdefault("expectedDurationMinutes", int(intervention["effectDurationMinutes"]))
                action["expectedEffect"] = (  # the agent's reason stays verbatim in `rationale`; how the aircraft works goes with its effect
                    f"{action.get('expectedEffect', '')} Rotação: largada, reabastecimento a ~{water_km:.0f} km e volta, ~{rotation:.0f} min (cada largada molha ~{AIR_DROP_WET_MIN:.0f} min)"
                    + (f"; só voa de dia, até ao pôr do sol (T+{self._sunset:.0f})." if self._sunset is not None else ".")
                ).strip()
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
