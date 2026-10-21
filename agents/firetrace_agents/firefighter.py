"""Firefighter agents (squad member, fire truck, combat helicopter).

Each agent

1. **perceives** the situation from the API — ``GET /simulations/{id}/threatened``
   (what the fire will reach soon), ``GET /simulations/{id}/summary`` (how fast and
   hot it burns) — plus its own fleet entry (``GET /vehicles``) or
   ``GET /personnel-pools`` (a squad is people, not a vehicle);
2. **decides**, with the priority rule the user-facing requirements state:

   * fire *reaching people* within the horizon → objective ``protect_life``:
     moving ground tiers **evacuate first and only attack afterwards** (carried by an
     ``evacuation`` action followed by combat actions with
     ``trigger: {kind: on_action_complete}``); a helicopter cannot evacuate people,
     so its life-saving move is slowing the head toward the settlement (``aerial_drop``
     with ``retardant`` ahead of it) and its reason says exactly that;
   * fire *in an isolated region* → objective ``minimize_burned_area``: the suppression
     tool that tier is strongest with (helicopter → drops on the head; truck → direct
     crew attack, or a wet/machine line when the fire outruns crews — indirect;
     squad → handline, or fuel removal with hand tools when the fire is tame enough);
3. **reports** one :class:`DecisionMessage` to the orchestrator with
   ``reason`` attached — a quantified, plain-language explanation: what was chosen,
   why, and what it considered. The orchestrator forwards that reason verbatim into
   ``action.rationale`` so the operator sees the agent's justification.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Any, Callable

from .contracts import OBJECTIVES, INTERVENTION_TYPES
from .sectors import Assignment, Sector, line_across, line_segment, zone_around
from .tiers import FirefighterTier, tier_for_vehicle

# Spec ``Responsibility`` -> vehicle capabilities that let a vehicle take it (the backend warns
# ``responsibility_not_supported`` otherwise). Only what the agents assign is listed.
EVACUATION_CAPABILITIES = frozenset({"evacuation_transport", "traffic_control", "perimeter_security"})

LINE_FACTOR = {FirefighterTier.HELICOPTER: 1.5, FirefighterTier.TRUCK: 1.0, FirefighterTier.SQUAD: 0.8}
"""Half-length of the line a tier makes, in work-zone radii: an aircraft lays a long curtain, a crew on foot a short line."""

PROTECT_LIFE = "protect_life"
MINIMIZE_BURNED_AREA = "minimize_burned_area"


# ---------------------------------------------------------------------------
# Situation snapshot (perception)
# ---------------------------------------------------------------------------
@dataclass
class Situation:
    """Everything an agent needs at decision time, all fetched through the API."""

    simulation_id: str
    horizon_minutes: int
    threatened: dict[str, Any]
    summary: dict[str, Any]
    at_minute: int | None = None
    """Decision instant, minutes since ignition. ``None`` = the last milestone (end of the run)."""
    rules: dict[str, Any] | None = None
    """The backend's ``GET /rules`` (safety distances, suppression effectiveness...). ``None`` = defaults below."""
    ignition: dict[str, Any] | None = None
    """Where the fire started (the scenario's first ignition): the position of last resort."""
    life_horizon_minutes: int = 180
    """How far ahead the life planner looks: emptying a town takes hours, so it looks further than the fire fight does."""
    focus: Sector | None = None
    """The stretch of front this agent was assigned. When set, position, bearing, speed and intensity are *its* sector's."""
    initial_attack: bool = False
    """The fire is still weak enough, when the units get there, for direct attack to work: crews go on the fire's own outline and pile
    on the same ground (their effects multiply) instead of building lines ahead of it."""
    work_minutes: int = 60
    """How long a crew works its ground before the effect ends (an initial attack holds the fire for as long as a crew can work)."""

    @property
    def safe_distance_m(self) -> float:
        return float(((self.rules or {}).get("safety") or {}).get("minSafeDistanceM") or 100.0)

    @property
    def zone_radius_m(self) -> float:
        """Radius of the ground one crew works (``Rules.suppression.zoneRadiusM``)."""
        return float(((self.rules or {}).get("suppression") or {}).get("zoneRadiusM") or 180.0)

    @property
    def anchor(self) -> dict[str, Any]:
        """Where to act: the assigned sector, else the fire's head, else where it started. Never a guessed place."""
        position = self.head_position or self.ignition
        if not position:
            raise ValueError(f"no fire position for {self.simulation_id}: no sector, no head in the summary and no ignition")
        return position

    @property
    def head_bearing_deg(self) -> float:
        """Where the head is moving towards. Falls back to downwind (wind blows *from* ``windFromDeg``)."""
        if self.focus is not None:
            return self.focus.bearing_deg
        bearing = self.latest_milestone.get("headBearingDeg")
        if bearing is not None:
            return float(bearing)
        wind_from = (self.latest_milestone.get("wind") or {}).get("windFromDeg")
        return (float(wind_from) + 180.0) % 360.0 if wind_from is not None else 0.0

    def suppression_effectiveness(self, people: int, water_l: float) -> float:
        """The backend's own formula (``Rules.suppression``): base + per-crew term + water bonus, capped."""
        s = (self.rules or {}).get("suppression") or {}
        value = (
            float(s.get("baseEffectiveness", 0.15))
            + float(s.get("perCrewEquivalent", 0.12)) * people / max(float(s.get("personsPerCrewEquivalent", 4)), 1.0)
            + float(s.get("waterBonusPerThousandL", 0.02)) * water_l / 1000.0
        )
        return round(min(value, float(s.get("maxEffectiveness", 0.85))), 2)

    @property
    def threatened_places(self) -> list[dict[str, Any]]:
        """place/facility assets with people inside them, sorted by fire arrival."""
        assets = self.threatened.get("assets", [])
        hits = [
            asset
            for asset in assets
            if asset.get("assetType") in {"place", "facility"}
            and (asset.get("population") or asset.get("vulnerable"))
            and (asset.get("arrivalMinute") or {}).get("p50") is not None
        ]
        return sorted(hits, key=lambda asset: asset["arrivalMinute"]["p50"])

    @property
    def people_at_risk(self) -> int:
        return sum(int(asset.get("population") or 0) for asset in self.threatened_places)

    @property
    def latest_milestone(self) -> dict[str, Any]:
        milestones = self.summary.get("milestones") or []
        if self.at_minute is not None:
            # the fire as it is at the decision instant, not as it ends
            milestones = [m for m in milestones if m.get("tMin", -1) <= self.at_minute] or milestones[:1]
        if not milestones:
            return {}
        return max(milestones, key=lambda milestone: milestone.get("tMin", -1))

    @property
    def head_speed_mmin(self) -> float:
        if self.focus is not None:
            return self.focus.speed_mmin
        return float(self.latest_milestone.get("headSpeedMmin") or 0.0)

    @property
    def max_intensity_kwm(self) -> float:
        if self.focus is not None:
            return self.focus.intensity_kwm
        return float(self.latest_milestone.get("maxIntensityKwm") or 0.0)

    @property
    def head_position(self) -> dict[str, Any]:
        if self.focus is not None:
            return self.focus.position
        return self.latest_milestone.get("headPosition") or {}

    @property
    def snapshot_time(self) -> str | None:
        """RFC 3339 instant of the last milestone (plan ``basis.situationAsOf``)."""
        return self.latest_milestone.get("time")

    def first_arrival_minutes(self) -> float | None:
        arrivals = [asset["arrivalMinute"]["p50"] for asset in self.threatened_places]
        return min(arrivals) if arrivals else None

    def people_in_danger_within(self, horizon: int | None = None) -> list[dict[str, Any]]:
        """Threatened places whose fire arrival (p50) falls inside the horizon (the fighting horizon unless another is given)."""
        limit = self.horizon_minutes if horizon is None else horizon
        return [asset for asset in self.threatened_places if asset["arrivalMinute"]["p50"] <= limit]


def situation_from_simulation(
    simulation_id: str,
    *,
    threatened: dict[str, Any],
    summary: dict[str, Any],
    horizon_minutes: int = 60,
    at_minute: int | None = None,
    rules: dict[str, Any] | None = None,
    ignition: dict[str, Any] | None = None,
    life_horizon_minutes: int = 180,
) -> Situation:
    return Situation(
        life_horizon_minutes=life_horizon_minutes,
        simulation_id=simulation_id,
        horizon_minutes=horizon_minutes,
        threatened=threatened,
        summary=summary,
        at_minute=at_minute,
        rules=rules,
        ignition=ignition,
    )


# ---------------------------------------------------------------------------
# Decision messages: how agents communicate with the orchestrator
# ---------------------------------------------------------------------------
@dataclass
class ActionProposal:
    """One concrete action an agent asks its command chain for."""

    action_type: str  # an ActionType value: fire_attack, evacuation, structure_protection
    title: str
    intervention: dict[str, Any]  # an Intervention oneOf shape → action.simulationEffects[0]
    proposal_id: str = ""
    """Stable action id inside the plan (``ActionBase.id``); other actions'
    ``dependsOn``/``trigger`` must reference exactly this id."""
    priority: str = "normal"
    depends_on: list[str] = field(default_factory=list)
    trigger: dict[str, Any] | None = None
    resources: list[dict[str, Any]] = field(default_factory=list)
    expected_effect: str = ""
    confidence: float = 0.5
    safety_notes: str = ""
    extra_action_fields: dict[str, Any] = field(default_factory=dict)
    """Action-schema fields specific to the type (``tactic`` for fire_attack,
    ``area``/``mode`` for evacuation, ``targets`` for structure_protection)."""
    target: dict[str, Any] | None = None
    """Where the unit has to get to (``LatLon``) when the intervention has no geometry to take it from (a place's position)."""
    eta_minutes: float | None = None
    """Set by the orchestrator from ``POST /routing/route``: minutes until the unit is on the spot (``None`` = not computed)."""
    from_station: str | None = None
    route: dict[str, Any] | None = None
    """The road (GeoJSON LineString) the backend routed this unit along; written into ``resources[].route`` of a crew on foot, whose route the backend does not compute."""
    delay_minutes: float = 0.0
    """Minutes before the unit can set off (a reinforcement still on its way to the municipality): the action is triggered then, and it arrives ``eta`` later."""

    def __post_init__(self) -> None:
        if self.action_type not in {"fire_attack", "evacuation", "structure_protection"}:
            raise ValueError(f"unknown action type {self.action_type!r}")
        kind = self.intervention.get("type")
        if kind not in INTERVENTION_TYPES:
            raise ValueError(f"intervention {kind!r} does not exist in the contract")
        # Tier-specific method checks happen at outcome-validation time (orchestrator).
        if self.intervention.get("planActionRef") is not None and self.intervention.get("planActionRef") != self.intervention.get("planActionRef"):
            raise ValueError("planActionRef must be a PlanActionRef shape or absent")


@dataclass
class DecisionMessage:
    """What a firefighter agent sends its orchestrator: choices plus the reason."""

    agent_id: str
    tier: FirefighterTier
    organization_id: str
    objective: str  # one of OBJECTIVES
    reason: str  # forwarded verbatim to action.rationale
    proposals: list[ActionProposal]
    confidence: float = 0.5
    address_to: str = "orchestrator"  # routing label; more kinds of message may follow

    def __post_init__(self) -> None:
        if self.objective not in OBJECTIVES:
            raise ValueError(f"{self.objective!r} is not an Objective value in the contract")
        if not self.proposals:
            raise ValueError("a decision with no proposals is not a decision")
        if not self.reason.strip():
            raise ValueError("every decision carries a reason (the user-facing requirement)")


@dataclass
class Observation:
    """Agent identity + fleet facts, from its own resource (vehicle or pool)."""

    agent_id: str
    tier: FirefighterTier
    vehicle_id: str | None
    organization_id: str
    crew_onboard: int
    water_capacity_l: float
    passenger_capacity: int
    capabilities: frozenset[str]
    station_id: str | None = None
    """Where the unit is based: the origin of its route (``fromStationId``)."""
    vehicle_type: str | None = None
    off_road: bool = False
    """A vehicle that can leave the road for the last stretch; everyone else walks it."""
    profile: dict[str, Any] | None = None
    """What limits the roads a vehicle can use (``VehicleProfile``: height, width, weight, speed, slope): sent with every route request."""
    pump_lpm: float = 0.0
    """The vehicle's pump flow (``pumpFlowLpm``): with its tank, how long it works before going to refill (``duty.py``)."""
    mobilization_min: float = 0.0
    """A reinforcement from another district: minutes after the call before it reaches its entry point (``metadata["agents.mobilizationMinutes"]``)."""


# ---------------------------------------------------------------------------
# The agent
# ---------------------------------------------------------------------------
class FirefighterAgent:
    """One firefighter unit: a squad member, a fire truck, or a combat helicopter."""

    SAFETY_MARGIN_MIN = 15  # minutes of headway we insist on before the fire arrives

    def __init__(self, observation: Observation) -> None:
        self._assignment = Assignment()
        self.observation = observation
        self.agent_id = observation.agent_id
        self.tier = observation.tier

    # -- factory from API resources ---------------------------------------------
    @classmethod
    def from_vehicle(cls, vehicle: dict[str, Any], agent_id: str) -> "FirefighterAgent" | None:
        """Truck or helicopter agent from a ``GET /vehicles`` entry (None → skip)."""
        tier = tier_for_vehicle(vehicle.get("type", ""))
        if tier is None:
            return None
        return cls(
            Observation(
                agent_id=agent_id,
                tier=tier,
                vehicle_id=vehicle.get("id"),
                organization_id=vehicle.get("organizationId") or "org-unknown",
                crew_onboard=int(vehicle.get("crewCapacity") or 0),
                water_capacity_l=float(vehicle.get("waterCapacityL") or 0.0),
                passenger_capacity=int(vehicle.get("passengerCapacity") or 0),
                capabilities=frozenset(vehicle.get("capabilities") or []),
                station_id=vehicle.get("stationId"),
                vehicle_type=vehicle.get("type"),
                off_road=bool(vehicle.get("offRoad")),
                profile={
                    **{k: vehicle[k] for k in ("heightM", "widthM", "weightT", "maxSlopePercent") if vehicle.get(k) is not None},
                    **({"offRoad": True} if vehicle.get("offRoad") else {}),
                    **({"speedKmh": vehicle["cruiseSpeedKmh"]} if vehicle.get("cruiseSpeedKmh") is not None else {}),
                },
                pump_lpm=float(vehicle.get("pumpFlowLpm") or 0.0),
                mobilization_min=float((vehicle.get("metadata") or {}).get("agents.mobilizationMinutes") or 0.0),
            )
        )

    @classmethod
    def from_personnel_pool(cls, pool: dict[str, Any], agent_id: str) -> "FirefighterAgent" | None:
        """Squad agent from a ``GET /personnel-pools`` firefighting entry (None → skip)."""
        if (pool.get("role") or "") not in {"firefighter", "forest_firefighter", "crew_leader"}:
            return None
        available = int(pool.get("available") or 0)
        if available <= 0:
            return None
        return cls(
            Observation(
                agent_id=agent_id,
                tier=FirefighterTier.SQUAD,
                vehicle_id=None,  # a squad is a personnel pool, never a vehicle
                organization_id=pool.get("organizationId") or "org-unknown",
                crew_onboard=available,
                water_capacity_l=0.0,
                passenger_capacity=0,
                capabilities=frozenset(pool.get("certifications") or []),
                station_id=pool.get("stationId"),
            )
        )

    # -- decide -----------------------------------------------------------------
    def decide(self, situation: Situation, assignment: Assignment | None = None) -> DecisionMessage:
        """``assignment`` is what the orchestrator gave this unit (its sector of the front and its place); without one the
        unit acts on the fire's head, which is what every unit did before sectors existed."""
        self._assignment = assignment or Assignment()
        if self._assignment.reserve and situation.initial_attack:
            situation = replace(situation, initial_attack=False, work_minutes=60)  # no room on the outline: the usual tactic
        if self._assignment.sector is not None:
            situation = replace(situation, focus=self._assignment.sector)  # position, bearing, speed and intensity of *its* sector
        if self._assignment.place is not None:
            in_danger = [self._assignment.place]  # the life planner gave this unit its own place (possibly beyond the fighting horizon)
        elif assignment is not None:
            in_danger = []  # an orchestrator is in charge and gave this unit no place: it keeps fighting the fire
        else:
            in_danger = situation.people_in_danger_within()  # no orchestrator: every unit reacts to the people in its horizon
        if in_danger:
            proposals, reason, confidence = self._protect_life(situation, in_danger)
            objective = PROTECT_LIFE
        else:
            proposals, reason, confidence = self._minimize_burned_area(situation)
            objective = MINIMIZE_BURNED_AREA
        for index, proposal in enumerate(proposals):
            proposal.intervention.setdefault("start", {"offsetMinutes": 0})
            proposal.intervention.pop("planActionRef", None)
            proposal.proposal_id = proposal.proposal_id or f"act-{self.agent_id}-{index:02d}"
            if proposal.action_type == "fire_attack":  # LCES: the backend warns `missing_safety` without it
                for key, value in self._lces(situation, proposal.intervention.get("geometry")).items():
                    proposal.extra_action_fields.setdefault(key, value)
                self._keep_safe(proposal)
            elif self._assignment.place is not None and self._assignment.stay_minutes:
                # defending houses or evacuating: the crew prepares the place and leaves before the fire reaches it (the backend counts it there for this long)
                proposal.extra_action_fields["expectedDurationMinutes"] = int(self._assignment.stay_minutes)
                if proposal.intervention.get("type") == "crew_deployment" and proposal.intervention.get("durationMinutes"):
                    proposal.intervention["durationMinutes"] = int(min(int(proposal.intervention["durationMinutes"]), self._assignment.stay_minutes))
        return DecisionMessage(
            agent_id=self.agent_id,
            tier=self.tier,
            organization_id=self.observation.organization_id,
            objective=objective,
            reason=reason,
            proposals=proposals,
            confidence=confidence,
        )

    def _keep_safe(self, proposal: ActionProposal) -> None:
        """Where the orchestrator found a safe spot (``placement.py``), the crew works from there and only as long as it is safe: the backend counts a crew as
        caught by where its action is anchored and for how long it stays (``expectedDurationMinutes``)."""
        if self._assignment.site is not None and proposal.target is None:
            proposal.target = dict(self._assignment.site)
        if self._assignment.start_after is not None:
            begin = int((proposal.intervention.get("start") or {}).get("offsetMinutes") or 0)
            proposal.intervention["start"] = {"offsetMinutes": max(begin, int(self._assignment.start_after))}
        stay = self._assignment.stay_minutes
        if stay:
            if proposal.intervention.get("type") == "crew_deployment":
                proposal.intervention["durationMinutes"] = int(min(int(proposal.intervention.get("durationMinutes") or stay), stay))
            proposal.extra_action_fields["expectedDurationMinutes"] = int(stay)

    def _lces(self, situation: Situation, geometry: dict[str, Any] | None) -> dict[str, Any]:
        """Lookouts, Communications, Escape routes, Safety zones: an escape line and a safety zone *away* from
        the head (opposite its bearing) and a lookout on the flank. Distances come from the backend's `/rules`."""
        lat, lon = _centroid(geometry) if geometry else (None, None)
        if lat is None:
            position = situation.anchor
            lat, lon = float(position["lat"]), float(position["lon"])
        bearing = situation.head_bearing_deg
        safe_lat, safe_lon = _destination(lat, lon, (bearing + 180.0) % 360.0, max(situation.safe_distance_m * 3.0, 300.0))
        look_lat, look_lon = _destination(lat, lon, (bearing + 90.0) % 360.0, situation.safe_distance_m)
        return {
            "escapeRoutes": [{"type": "LineString", "coordinates": [[lon, lat], [safe_lon, safe_lat]]}],
            "safetyZones": [{"lat": safe_lat, "lon": safe_lon}],
            "lookouts": [{"lat": look_lat, "lon": look_lon}],
        }

    # -- where this unit works ------------------------------------------------------
    def _line(self, situation: Situation, position: dict[str, Any] | None = None) -> dict[str, Any]:
        """A line *across* the fire's path at the unit's sector (or at ``position``), as long as its tier can build;
        units sharing a sector are laid side by side (``slot``) instead of on top of each other."""
        at = position or situation.anchor
        if position is None and self._assignment.segment_m:
            # the orchestrator measured what this unit can build in the stage, and where its piece sits in the barrier
            return line_segment(float(at["lat"]), float(at["lon"]), situation.head_bearing_deg, self._assignment.segment_m, self._assignment.offset_m)
        half = situation.zone_radius_m * LINE_FACTOR[self.tier]
        return line_across(float(at["lat"]), float(at["lon"]), situation.head_bearing_deg, half, self._assignment.slot)

    def _zone(self, situation: Situation, factor: float = 1.0) -> dict[str, Any]:
        """The ground one crew works around its sector (``Rules.suppression.zoneRadiusM``), beside its neighbours; around its own safe spot when it has one."""
        if self._assignment.site is not None:
            at = self._assignment.site
            return zone_around(float(at["lat"]), float(at["lon"]), situation.head_bearing_deg, situation.zone_radius_m * factor, 0)
        at = situation.anchor
        return zone_around(float(at["lat"]), float(at["lon"]), situation.head_bearing_deg, situation.zone_radius_m * factor, self._assignment.slot)

    # -- branch 1: people in the path → evacuate first ----------------------------
    def _protect_life(self, situation: Situation, in_danger: list[dict[str, Any]]) -> tuple[list[ActionProposal], str, float]:
        if in_danger[0].get("assetType") == "building_zone":
            return self._defend_zone(situation, in_danger[0])
        arrival = min(asset["arrivalMinute"]["p50"] for asset in in_danger)
        names = ", ".join(str(asset.get("name") or asset["id"]) for asset in in_danger)
        people = sum(int(asset.get("population") or 0) for asset in in_danger)
        base = (
            f"Fogo a chegar a {names} em ~{arrival:.0f} min (p50; horizonte {situation.horizon_minutes} min), "
            f"{people} pessoas em risco."
        )

        if self.tier is FirefighterTier.HELICOPTER:
            place = in_danger[0]
            agent = "retardant" if situation.max_intensity_kwm < 3000 else "water"
            effectiveness = 0.45 if situation.max_intensity_kwm < 3000 else 0.3
            confidence = 0.55
            proposals = [
                ActionProposal(
                    action_type="fire_attack",
                    title=f"Travar a frente rumo a {names} (largada {agent})",
                    proposal_id=f"drop-{self.agent_id}",
                    intervention={
                        "type": "aerial_drop",
                        "label": f"Cortina {names}",
                        "start": {"offsetMinutes": 0},
                        "geometry": self._line(situation, place.get("position")),
                        "agent": agent,
                        "effectiveness": effectiveness,
                        "effectDurationMinutes": 45,
                    },
                    priority="critical",
                    resources=self._air_resources(),
                    expected_effect="Atrasa a chegada do fogo às localidades, comprando minutos de margem.",
                    confidence=0.55,
                    safety_notes="Vento forte e faíscas; não sobrevoar a frente ativa.",
                    extra_action_fields={"tactic": "indirect"},  # ponto à frente da frente, nunca sobre ela
                )
            ]
            reason = (
                f"{base} Eu não evacuo (largada aérea não transporta pessoas): travo a frente com "
                f"retardante/água à frente das localidades para dar margem às equipas no terreno."
            )
            return proposals, reason, confidence

        if self.tier is FirefighterTier.TRUCK and not (self.observation.capabilities & EVACUATION_CAPABILITIES):
            # A fire engine without transport/traffic/perimeter capability may not be assigned `evacuation`
            # (backend: responsibility_not_supported). Its way of protecting people is defending their homes.
            return self._protect_structures(situation, in_danger, base, arrival, people, names)

        evacuation_id = f"evap-{self.agent_id}"
        evacuation = ActionProposal(
            action_type="evacuation",
            title=f"Evacuar {names} antes da chegada do fogo",
            proposal_id=evacuation_id,
            intervention={
                "type": "evacuation",
                "label": f"Evacuação {names}",
                "start": {"offsetMinutes": 0},
                "geometry": _area_around(in_danger[0].get("position")),
                "placeIds": [asset["id"] for asset in in_danger],
                "completeBy": {"offsetMinutes": max(int(arrival) - self.SAFETY_MARGIN_MIN, 5)},
                "population": people,
            },
            priority="critical",
            resources=self._evac_resources(),
            expected_effect=f"{people} pessoas fora da área antes de ~{arrival:.0f} min.",
            confidence=0.75,
            safety_notes="Rotas de fuga opostas ao avanço; não bloquear a via que as equipas precisam depois.",
            extra_action_fields={
                "area": _area_around(in_danger[0].get("position")),
                "mode": "mandatory" if arrival <= 60 else "precautionary",
                "priorityGroups": ["reduced_mobility", "children"],
                "estimatedPeople": people,
            },
        )

        follow_ups: list[ActionProposal] = []
        if self.tier is FirefighterTier.TRUCK:
            # If the truck can reach people AND fight, first evacuation, then suppression.
            suppression = self._truck_suppression(situation)
            suppression[0].title += " (só após a evacuação)"
            suppression[0].priority = "high"
            follow_ups = suppression
        else:  # a bare squad on foot: guide people out, then keep watching its zone
            suppression = self._squad_suppression(situation)
            suppression[0].title += " (só após a evacuação)"
            suppression[0].priority = "high"
            follow_ups = suppression
        for follow in follow_ups:
            follow.depends_on.append(evacuation_id)
            follow.trigger = {"kind": "on_action_complete", "actionId": evacuation_id}

        quantified = f"evacuar primeiro ({people} pessoas; margem {self.SAFETY_MARGIN_MIN} min), depois {follow_ups[0].intervention['type']} em sequência."
        reason = f"{base} A minha decisão pela regra 'vidas primeiro': {quantified}"
        return [evacuation, *follow_ups], reason, 0.75

    def _defend_zone(self, situation: Situation, zone: dict[str, Any]) -> tuple[list[ActionProposal], str, float]:
        """Defend a patch of ground with houses on it (not a backend place): the engine stays and wets the buildings.

        The target is the zone's geometry. Engines assigned to the same zone each carry their own effectiveness and the backend
        multiplies them, so three engines on one zone protect it far more than one.
        """
        effectiveness = situation.suppression_effectiveness(self.observation.crew_onboard, self.observation.water_capacity_l)
        arrival = float(zone["arrivalMinute"]["p50"])
        buildings, people = int(zone.get("buildings") or 0), int(zone.get("population") or 0)
        protection = ActionProposal(
            action_type="structure_protection",
            title=f"Defender {buildings} edifícios (zona {zone['id']})",
            proposal_id=f"prot-{self.agent_id}",
            intervention={
                "type": "structure_protection",
                "label": f"Defesa {zone['id']}",
                "start": {"offsetMinutes": 0},
                "geometry": zone["geometry"],
                "effectiveness": effectiveness,
            },
            priority="high",
            resources=self._ground_resources("structure_protection"),
            expected_effect=f"Reduz os edifícios perdidos nesta zona (eficácia ~{effectiveness:.0%} por viatura, pelas regras do servidor).",
            confidence=0.7,
            safety_notes="Defender a partir da zona já ardida ou de segurança; retirar se o fogo chegar em menos do que o limite das regras.",
            extra_action_fields={"targets": [{"geometry": zone["geometry"], "label": str(zone["name"])}], "tactic": "wetting"},
        )
        reason = (
            f"O fogo previsto chega a {buildings} edifícios ({people} pessoas) em ~{arrival:.0f} min e nenhuma localidade os cobre: "
            f"defendo esta zona (eficácia ~{effectiveness:.0%} com {self.observation.crew_onboard} pessoas e {self.observation.water_capacity_l:.0f} L)."
        )
        return [protection], reason, 0.7

    def _protect_structures(
        self, situation: Situation, in_danger: list[dict[str, Any]], base: str, arrival: float, people: int, names: str
    ) -> tuple[list[ActionProposal], str, float]:
        suppression = self._truck_suppression(situation)
        if "structure_protection" not in self.observation.capabilities:
            reason = (
                f"{base} Não tenho capacidade de evacuação nem de proteção de estruturas: contribuo só com combate "
                f"({self._describe(suppression)})."
            )
            return suppression, reason, 0.5

        protection_id = f"prot-{self.agent_id}"
        effectiveness = situation.suppression_effectiveness(self.observation.crew_onboard, self.observation.water_capacity_l)
        first = in_danger[0]
        spot = first.get("position")
        # a facility (a camp site, a scout centre) is not a place: the backend finds neither its position nor its effect by ``placeId``, so it would route nobody and
        # check nothing. The target carries the id the right way round *and* the point, and the effect of a facility is the ground around it.
        shield = (
            {"geometry": zone_around(float(spot["lat"]), float(spot["lon"]), 0.0, 250.0, 0, 12)}
            if first.get("assetType") == "facility" and spot else {"placeId": first["id"]}
        )
        protection = ActionProposal(
            action_type="structure_protection",
            title=f"Defender {names} (proteção de edifícios)",
            proposal_id=protection_id,
            intervention={
                "type": "structure_protection",
                "label": f"Defesa {names}",
                "start": {"offsetMinutes": 0},
                **shield,
                "effectiveness": effectiveness,
            },
            priority="critical",
            resources=self._ground_resources("structure_protection"),
            expected_effect=f"Reduz os edifícios perdidos em {names} (eficácia ~{effectiveness:.0%}, pelas regras do servidor).",
            confidence=0.7,
            safety_notes="Defender a partir da zona já ardida ou de segurança; retirar se o fogo chegar em menos do que o limite das regras.",
            extra_action_fields={
                "targets": [
                    {
                        ("facilityId" if asset.get("assetType") == "facility" else "placeId"): asset["id"],
                        "label": str(asset.get("name") or asset["id"]),
                        **({"position": {"lat": asset["position"]["lat"], "lon": asset["position"]["lon"]}} if asset.get("position") else {}),
                    }
                    for asset in in_danger
                ],
                "tactic": "wetting",
            },
            target=in_danger[0].get("position"),  # the intervention names a place, not a point
        )
        for follow in suppression:
            follow.title += " (só após a defesa dos edifícios)"
            follow.priority = "high"
            follow.depends_on.append(protection_id)
            follow.trigger = {"kind": "on_action_complete", "actionId": protection_id}
        reason = (
            f"{base} Sou um carro de bombeiros sem capacidade de evacuação (só transporte, trânsito e segurança evacuam): "
            f"a minha forma de proteger vidas é defender os edifícios ({people} pessoas, eficácia ~{effectiveness:.0%}) e só depois combater."
        )
        return [protection, *suppression], reason, 0.7

    # -- branch 2: region isolated → reduce the burned area ------------------------
    def _minimize_burned_area(self, situation: Situation) -> tuple[list[ActionProposal], str, float]:
        arrival = situation.first_arrival_minutes()
        place_text = (
            "sem pessoas no caminho dentro do horizonte"
            if arrival is None
            else f"primeira ameaça a localidade só a {arrival:.0f} min (fora do horizonte de {situation.horizon_minutes})"
        )
        proposals = self._suppression(situation)
        severity = "coroa ativa" if situation.max_intensity_kwm >= 2500 else "fogo de superfície"
        reason = (
            f"Fogo em zona isolada ({place_text}); {severity} a {situation.max_intensity_kwm:.0f} kW/m com "
            f"frente a {situation.head_speed_mmin:.0f} m/min. Prioridade: reduzir a área ardida — "
            f"{self._describe(proposals)}."
        )
        return proposals, reason, 0.7

    def _suppression(self, situation: Situation) -> list[ActionProposal]:
        return TIER_SUPPRESSION[self.tier](self, situation)

    def _describe(self, proposals: list[ActionProposal]) -> str:
        return "; ".join(proposal.intervention["type"] for proposal in proposals)

    # -- resources ----------------------------------------------------------------
    def _ground_resources(self, responsibility: str = "firefighting") -> list[dict[str, Any]]:
        if self.tier is FirefighterTier.TRUCK:
            return [
                {
                    "resourceType": "vehicle",
                    "resourceId": self.observation.vehicle_id,
                    "personnel": self.observation.crew_onboard,
                    "responsibility": responsibility,
                }
            ]
        return [
            {
                "resourceType": "personnel_pool",
                "resourceId": self.observation.agent_id,
                "personnel": self.observation.crew_onboard,
                "responsibility": responsibility,
            }
        ]

    def _air_resources(self) -> list[dict[str, Any]]:
        return [
            {
                "resourceType": "vehicle",
                "resourceId": self.observation.vehicle_id,
                "responsibility": "firefighting",
            }
        ]

    def _evac_resources(self) -> list[dict[str, Any]]:
        return self._ground_resources("evacuation")

    # -- suppression per tier (isolated region) ------------------------------------
    def _helicopter_suppression(self, situation: Situation) -> list[ActionProposal]:
        agent = "water" if situation.max_intensity_kwm >= 2000 else "retardant"
        effectiveness = 0.6 if situation.max_intensity_kwm < 1500 else 0.45
        duration = 20 if agent == "water" else 45
        return [
            ActionProposal(
                action_type="fire_attack",
                title="Largada aérea na cabeça do fogo",
                intervention={
                    "type": "aerial_drop",
                    "label": "Largada cabeça",
                    "start": {"offsetMinutes": 0},
                    "geometry": self._line(situation),
                    "agent": agent,
                    "effectiveness": effectiveness,
                    "effectDurationMinutes": duration,
                },
                priority="high",
                resources=self._air_resources(),
                expected_effect="Freia a cabeça (retardante ~45 min de efeito; água ~20 min).",
                confidence=0.6,
                safety_notes="Corrente de convecção junto à cabeça; aproximar pela lateral.",
                extra_action_fields={"tactic": "direct"},
            )
        ]

    def _truck_suppression(self, situation: Situation) -> list[ActionProposal]:
        if situation.initial_attack or (situation.head_speed_mmin <= 8 and situation.max_intensity_kwm <= 2500):
            return [
                ActionProposal(
                    action_type="fire_attack",
                    title="Ataque inicial ao perímetro com água" if situation.initial_attack else "Ataque direto na cabeça com água",
                    intervention={
                        "type": "crew_deployment",
                        "responsibility": "firefighting",
                        "label": "Ataque direto cabeça",
                        "start": {"offsetMinutes": 0},
                        "personnel": self.observation.crew_onboard,
                        "vehicles": 1,
                        "waterL": self.observation.water_capacity_l,
                        "geometry": self._zone(situation),
                        "durationMinutes": situation.work_minutes,
                    },
                    priority="high",
                    resources=self._ground_resources(),
                    expected_effect="Equipa + água na frente apaga a cabeça do fogo.",
                    confidence=0.65,
                    safety_notes="Manter via de fuga oposta ao vento; LCES.",
                    extra_action_fields={"tactic": "direct"},
                )
            ]
        # Fire outruns crews → indirect: build a wide wet/machine line behind safety.
        return [
            ActionProposal(
                action_type="fire_attack",
                title="Linha molhada no flanco (indireto)",
                intervention={
                    "type": "fire_line",
                    "label": "Linha molhada flanco",
                    "start": {"offsetMinutes": 0},
                    "geometry": self._line(situation),
                    "constructionMinutes": 40,
                    "effectiveness": 0.8,
                    "method": "wet_line",
                },
                priority="high",
                resources=self._ground_resources(),
                expected_effect="Linha bloqueia ~80% da propagação ao ser cruzada pela frente.",
                confidence=0.6,
                safety_notes="Linha fora do alcance de faíscas; raio > 2× altura das chamas.",
                extra_action_fields={"tactic": "indirect"},
            )
        ]

    def _squad_suppression(self, situation: Situation) -> list[ActionProposal]:
        if situation.initial_attack:
            # a crew on foot is worth ~0.6 on its own (the rules: base + per-crew term) and it adds to the engines on the same ground
            return [
                ActionProposal(
                    action_type="fire_attack",
                    title="Ataque inicial ao perímetro (a pé)",
                    intervention={
                        "type": "crew_deployment",
                        "responsibility": "firefighting",
                        "label": "Ataque inicial a pé",
                        "start": {"offsetMinutes": 0},
                        "personnel": self.observation.crew_onboard,
                        "vehicles": 0,
                        "waterL": 0,
                        "geometry": self._zone(situation),
                        "durationMinutes": situation.work_minutes,
                    },
                    priority="high",
                    resources=self._ground_resources(),
                    expected_effect="Equipa a pé no perímetro, com os autotanques, trava o fogo enquanto ainda é fraco.",
                    confidence=0.6,
                    safety_notes="Atacar a partir da zona já ardida; vigia e via de fuga pelo flanco; retirar se o fogo passar do limite das regras.",
                    extra_action_fields={"tactic": "direct"},
                )
            ]
        strip = self._assignment.fuel_strip
        if strip is not None:
            # the orchestrator found ground ahead of the fire this crew can clear before the fire gets there (see `fuelbreak.py`)
            return [
                ActionProposal(
                    action_type="fire_attack",
                    title=f"Faixa corta-fogo à frente ({strip.length_m:.0f} m, {strip.build_minutes} min de trabalho)",
                    intervention={
                        "type": "fuel_removal",
                        "label": "Faixa corta-fogo",
                        "start": {"offsetMinutes": 0},
                        "geometry": strip.geometry,
                        "method": "hand_tool",
                        "constructionMinutes": strip.build_minutes,
                        "effectiveness": 0.6,  # the contract's field (the backend ignores it) ...
                        "removal": "understory",  # ... and the backend's own: what the crew clears (the spec does not have it yet)
                    },
                    priority="high",
                    resources=self._ground_resources(),
                    expected_effect=f"Uma equipa a pé abre {strip.length_m:.0f} m de faixa sem mato à frente do fogo, em terreno que ainda não arde, e termina antes de ele chegar: a frente abranda ao atingi-la.",
                    confidence=0.5,
                    safety_notes="Trabalha em terreno por queimar, com via de fuga pelo lado de trás; sai quando a faixa está feita.",
                    extra_action_fields={"tactic": "indirect", "expectedDurationMinutes": strip.build_minutes},
                    target=strip.center,
                )
            ]
        return [
            ActionProposal(
                action_type="fire_attack",
                title="Handline no flanco",
                intervention={
                    "type": "fire_line",
                    "label": "Handline flanco",
                    "start": {"offsetMinutes": 0},
                    "geometry": self._line(situation),
                    "constructionMinutes": 60,
                    "effectiveness": 0.7,
                    "method": "handline",
                },
                priority="high",
                resources=self._ground_resources(),
                expected_effect="Handline bloqueia ~70% da propagação no flanco onde a frente atinge.",
                confidence=0.5,
                safety_notes="Squad a pé: zonas de fuga registadas, vigilante posto.",
                extra_action_fields={"tactic": "parallel"},
            )
        ]


# Who does what on the suppression side, per tier (frozen after the class body):
TIER_SUPPRESSION: dict[FirefighterTier, Callable[[FirefighterAgent, Situation], list[ActionProposal]]] = {
    FirefighterTier.HELICOPTER: FirefighterAgent._helicopter_suppression,
    FirefighterTier.TRUCK: FirefighterAgent._truck_suppression,
    FirefighterTier.SQUAD: FirefighterAgent._squad_suppression,
}


# ---------------------------------------------------------------------------
# geometry helpers (GeoJSON, [lon, lat] — contract convention)
# ---------------------------------------------------------------------------
def _centroid(geometry: dict[str, Any]) -> tuple[float | None, float | None]:
    """(lat, lon) of the mean vertex of a LineString/Polygon/Point; (None, None) if there is none."""
    coords = geometry.get("coordinates")
    kind = geometry.get("type")
    if kind == "Point" and coords:
        return float(coords[1]), float(coords[0])
    if kind == "LineString" and coords:
        points = coords
    elif kind == "Polygon" and coords and coords[0]:
        points = coords[0][:-1] or coords[0]
    else:
        return None, None
    return sum(float(p[1]) for p in points) / len(points), sum(float(p[0]) for p in points) / len(points)


def _destination(lat: float, lon: float, bearing_deg: float, distance_m: float) -> tuple[float, float]:
    """Point ``distance_m`` from (lat, lon) along ``bearing_deg`` (0 = north), on a sphere."""
    radius = 6_371_008.8
    brg, ang = math.radians(bearing_deg), distance_m / radius
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(ang) + math.cos(p1) * math.sin(ang) * math.cos(brg))
    l2 = l1 + math.atan2(math.sin(brg) * math.sin(ang) * math.cos(p1), math.cos(ang) - math.sin(p1) * math.sin(p2))
    return math.degrees(p2), math.degrees(l2)


def _area_around(position: dict[str, Any] | None, radius_deg: float = 0.004) -> dict[str, Any]:
    """A square around a place (evacuation area). The place must have a position: nothing is guessed."""
    if not position:
        raise ValueError("cannot draw an area around a place with no position")
    lat, lon = float(position["lat"]), float(position["lon"])
    ring = [
        [lon - radius_deg, lat - radius_deg],
        [lon + radius_deg, lat - radius_deg],
        [lon + radius_deg, lat + radius_deg],
        [lon - radius_deg, lat + radius_deg],
        [lon - radius_deg, lat - radius_deg],
    ]
    return {"type": "Polygon", "coordinates": [ring]}


__all__ = [
    "FirefighterAgent",
    "Observation",
    "Situation",
    "DecisionMessage",
    "ActionProposal",
    "situation_from_simulation",
    "PROTECT_LIFE",
    "MINIMIZE_BURNED_AREA",
]
