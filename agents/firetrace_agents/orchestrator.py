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

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Iterable

from .client import ApiProblem, FiretraceClient
from .contracts import UNSAFE_ON_WIRE, validate_against_spec
from .firefighter import ActionProposal, DecisionMessage, FirefighterAgent, Situation, situation_from_simulation
from .sectors import Assignment, Sector, assign_units, plan_sectors
from .tiers import ORCHESTRATOR_ONLY, FirefighterTier, can_execute, explain_denial


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
    ) -> CycleResult:
        """Situation → decisions → validation → plans A and B (→ ``POST /plans``).

        ``at_minute`` is the decision instant (minutes since ignition). Without it the situation is the
        end of the run, which is rarely what a commander decides on.
        """
        simulation = self._simulation(simulation_id)
        ignitions = ((simulation or {}).get("scenarioSnapshot") or {}).get("ignitions") or []
        situation = situation_from_simulation(
            simulation_id,
            threatened=self.client.get_threatened(simulation_id, horizon_minutes=horizon_minutes, t_min=at_minute),
            summary=self.client.get_summary(simulation_id),
            horizon_minutes=horizon_minutes,
            at_minute=at_minute,
            rules=self._load_rules(),
            ignition=ignitions[0].get("position") if ignitions else None,
        )
        if not self.agents:
            self.pull_fleet()
        if not self.agents:
            raise RuntimeError("no firefighter agents available from the fleet")

        result = CycleResult(simulation_id=simulation_id)
        result.assignments = self._assign_sectors(situation, simulation)
        for agent in self.agents:
            message = agent.decide(situation, result.assignments.get(agent.agent_id))
            result.decisions.append(message)

        guarded = self._guard_decisions(result)
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

    def _assign_sectors(self, situation: Situation, simulation: dict[str, Any] | None) -> dict[str, Assignment]:
        """Spread the units over the fire front instead of letting each one aim at the head.

        The front comes from the backend's spread vectors one horizon ahead of the decision (where the fire will be
        when the units are working), falling back to the decision instant itself. Threatened places are dealt out too.
        """
        decided_at = situation.at_minute
        if decided_at is None:
            decided_at = int(situation.latest_milestone.get("tMin") or 0)
        duration = ((simulation or {}).get("scenarioSnapshot") or {}).get("durationMinutes")
        ahead = decided_at + situation.horizon_minutes
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
        units = [(agent.agent_id, agent.tier.value) for agent in self.agents]
        return assign_units(units, sectors, situation.people_in_danger_within())

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
            action["simulationEffects"] = [intervention]
            action.update({key: value for key, value in proposal.extra_action_fields.items() if value is not None})
            actions.append(action)
            summary.append(f"- **{message.agent_id}** ({message.tier.value}, {message.objective}): {message.reason}")
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
