"""The tactics knowledge base: short cards, each with the conditions of the environment it fits.

Three kinds of card:

* **engine** cards (``pinned``): how THIS engine and these rules behave — direct attack limits, lines, the safety rule, aircraft, house
  defence. Always given to the commander, with the live numbers from ``GET /rules`` and the brief filled in, so it reasons with our physics
  and not with generic doctrine alone.
* **tactic** cards: firefighting doctrine (LCES, anchor and flank, indirect attack, structure triage...), each with the conditions on the
  environment brief (``environment.py``) under which it applies.
* **lesson** cards: what the FireTrace runs measured, with the numbers, so the commander knows what worked here.

A condition is ``(field, op, value)``: ``field`` is a dotted path in the brief, ``op`` one of ``== != >= <= > <``, and ``value`` a constant or
``"@path"`` (another brief field). A card applies when all its conditions hold; a field the brief does not have makes the condition false.
``maps_to`` says which strategy fields (``schema.py``) the card supports. Text may use ``{path}`` placeholders, filled from the brief.

More cards can be added as JSON files (a list of objects with these keys) in the directory ``AGENTS_TACTICS_DIR``.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

Condition = tuple[str, str, Any]


@dataclass(frozen=True)
class Card:
    id: str
    kind: str  # engine | tactic | lesson
    title: str
    do: str
    when: tuple[Condition, ...] = ()
    avoid: str = ""
    safety: str = ""
    maps_to: dict[str, Any] = field(default_factory=dict)
    evidence: str = ""
    source: str = ""
    pinned: bool = False


def _c(id: str, kind: str, title: str, do: str, *, when: list[Condition] | None = None, **rest: Any) -> Card:  # noqa: A002 — the card's id
    return Card(id=id, kind=kind, title=title, do=do, when=tuple(when or ()), **rest)


CARDS: list[Card] = [
    # ---------------------------------------------------------------- how this engine and these rules behave (always given)
    _c("engine-direct-attack", "engine", "Direct attack limits in this engine",
       "A crew's or an aircraft's direct effect is full up to {rules.full_kwm} kW/m and none from {rules.none_kwm} kW/m (linear between). It faces the "
       "intensity in the direction the fire spreads into its ground: a flank burns at a fraction of the head, so flanks can be worked while the head cannot.",
       source="FireTrace backend: Rules.suppression, SuppressionIndex", pinned=True),
    _c("engine-lines", "engine", "Control lines and fuel strips in this engine",
       "A finished line (wet line, handline) stops the fire that reaches it up to {rules.line_hold_kwm} kW/m and is breached from {rules.line_breach_kwm} kW/m. "
       "It counts only from when it is finished; one that the fire reaches first does nothing. A fuel strip slows the spread where the fuel is cut.",
       source="FireTrace backend: InterventionSettings.LineHoldFullKwm / LineBreachKwm", pinned=True),
    _c("engine-safety", "engine", "The zero-casualty rule is enforced by code",
       "Every plan is simulated on the forecast and on a ±30° wrong wind. Any crew the fire would reach is cut short or not sent. A strategy that puts "
       "crews ahead of a crown run loses those crews before they act, so it is weaker than it looks on paper.",
       source="FireTrace agents: judge.py", pinned=True),
    _c("engine-aircraft", "engine", "Aircraft in this engine",
       "Aircraft fly by day only (sunset in about {time.minutes_to_sunset} min from the decision). A water drop keeps the ground wet about 20 min; between drops "
       "an aircraft flies to refill (rotation = 2 × distance to water / speed + load + drop). Their effect fades with intensity like a crew's. "
       "There are {fleet.aircraft} aircraft, {fleet.aircraft_before_crown} of them overhead before the fire passes {rules.full_kwm} kW/m.",
       source="FireTrace agents: orchestrator._air_rotation, daylight.py", pinned=True),
    _c("engine-houses", "engine", "House defence in this engine",
       "Engines defending a patch of houses prepare it and leave before the fire arrives. Each engine on a patch multiplies its houses' survival. "
       "Defending only the houses reached first protects few; defending every patch reached in the whole run catches the late ones too.",
       source="FireTrace agents: orchestrator._plan_buildings", pinned=True),

    # ---------------------------------------------------------------- doctrine
    _c("lces", "tactic", "LCES on every assignment",
       "Lookouts, communications, escape routes and safety zones for every crew; work from the black; withdraw before the fire arrives.",
       safety="Never above the fire on a slope; never ahead of a crown run.", source="LCES (US/EU wildland firefighting doctrine)"),
    _c("attack-to-extinguish", "tactic", "Attack to put it out while it is weak",
       "When the first crews arrive before the fire outgrows direct attack, put everything that can work safely on its edge: the fire is put out "
       "while small, which protects the houses best.",
       when=[("attack.initial_attack", "==", True), ("fire.head_kwm_at_arrival", "<", "@rules.none_kwm")],
       maps_to={"mode": "auto", "reserve_share": 0.0}, source="Initial attack doctrine"),
    _c("anchor-and-flank", "tactic", "Anchor and attack the flanks",
       "When the head is too strong but most of the edge is not, anchor at a safe point and attack both flanks towards the head from the black; "
       "leave the head to aircraft or to a line ahead.",
       when=[("fire.head_kwm_at_arrival", ">=", "@rules.none_kwm"), ("fire.workable_edge_share", ">=", 0.5)],
       avoid="Attacking the head of a crown run.", maps_to={"mode": "auto"}, source="Anchor-and-flank doctrine"),
    _c("indirect-attack", "tactic", "Indirect attack: lines and strips ahead",
       "When neither head nor flanks can be attacked, build wet lines and fuel strips ahead of the fire where they are finished before it arrives, "
       "and defend what is in its way.",
       when=[("fire.head_kwm_at_arrival", ">=", "@rules.none_kwm"), ("fire.workable_edge_share", "<", 0.5)],
       maps_to={"mode": "contain", "fuel_breaks": True}, source="Indirect attack doctrine"),
    _c("fuel-strips-time", "tactic", "Fuel strips need time",
       "A crew opens about 15 m of strip per person per hour; it is worth it only where there is time to finish it before the fire arrives.",
       when=[("time.run_minutes", ">=", 180), ("fleet.squads", ">=", 2)],
       maps_to={"fuel_breaks": True}, source="FireTrace backend: FuelRemoval.CrewRateMPerHourPerPerson"),
    _c("early-air-attack", "tactic", "Aircraft on the head before it crowns",
       "When the fire will outgrow direct attack before the bulk of the crews arrives, the aircraft already overhead go at once and keep dropping on "
       "the head's path until the crews get there: holding the surface fire low keeps it out of the crowns.",
       when=[("fire.crowns_before_crews", "==", True), ("fleet.aircraft_before_crown", ">=", 1)],
       maps_to={"aircraft": "head_corridor"}, source="Initial air attack doctrine"),
    _c("air-with-crews", "tactic", "Aircraft prepare the ground for the crews",
       "When the fire is still weak when the crews arrive, each aircraft drops on the stretch where the next crews go in, a few minutes before them.",
       when=[("fire.crowns_before_crews", "==", False)],
       maps_to={"aircraft": "timed_with_crews"}, source="Air-ground coordination doctrine"),
    _c("structure-triage", "tactic", "Structure triage: defend what can be defended",
       "Split the houses in the fire's path into patches; defend the patches that can be prepared and left safely before the fire arrives.",
       when=[("houses.affected_no_response", ">=", 1)],
       maps_to={"house_zones": 4}, source="Structure protection doctrine"),
    _c("contain-and-protect", "tactic", "Protect people and houses along the fire's whole run",
       "When the fire will crown before the crews can stop it and many houses lie in its path, the houses are saved by defending them: defend every "
       "patch the fire reaches in the run, with more engines on each. Defending the houses does not need containment: keep mode \"auto\" so the "
       "first crews still attack the fire while it is weak; force \"contain\" only when the engine's test already says there is no initial attack.",
       when=[("fire.crowns_before_crews", "==", True), ("houses.affected_no_response", ">=", 10)],
       maps_to={"mode": "auto", "house_zones": 10, "defend_whole_run": True, "engines_per_zone": 5}, source="Structure protection doctrine"),
    _c("evacuate-early", "tactic", "Evacuate early, shelter when it is too late",
       "People in the path are evacuated with a margin before the fire arrives; where there is no time left they shelter in place. Vulnerable people first.",
       when=[("people.at_risk", ">", 0)], source="Proteção Civil evacuation doctrine"),
    _c("reserve-only-when-containing", "tactic", "No reserve while the fire can be put out",
       "A reserve held back while the fire can still be put out is the force that would have put it out. Keep a reserve only when the fire must be contained.",
       when=[("attack.initial_attack", "==", True)], maps_to={"reserve_share": 0.0}, source="Initial attack doctrine"),
    _c("forward-reserve", "tactic", "A forward reserve when containing",
       "When the fire must be contained for hours, keep about a quarter of the units in a forward reserve close to the fire for the re-plans or a new outbreak.",
       when=[("attack.initial_attack", "==", False), ("fleet.ground", ">=", 20)],
       maps_to={"reserve_share": 0.25}, source="Extended attack doctrine"),
    _c("late-reinforcements", "tactic", "Reinforcements that arrive late do not change the first hours",
       "Reinforcements from other districts arrive after the fire has grown: plan the first hours with the local and pre-positioned units.",
       when=[("fleet.reinforcement_first_min", ">", "@fire.crown_onset_min")], source="Extended attack doctrine"),
    _c("night-window", "tactic", "Contain by day, attack at night",
       "Humidity rises and intensity falls after sunset: contain and defend by day, then attack the edge when the fire drops below the direct-attack limit.",
       when=[("time.minutes_to_sunset", "<", "@time.run_minutes")], source="Extended attack doctrine"),
    _c("aircraft-stop-at-sunset", "tactic", "Aircraft stop at sunset",
       "Plan the air effort before sunset; after it the ground crews carry the fight alone.",
       when=[("time.minutes_to_sunset", "<", "@time.run_minutes")], source="Rules.aerial.limits.dayOnly"),
    _c("wind-shift", "tactic", "A wind shift turns flanks into heads",
       "With a wind shift forecast, keep crews off the stretches that become the head and prefer lines that hold from either side.",
       when=[("weather.wind_shift_deg", ">=", 30)], source="Fire behaviour doctrine"),
    _c("strong-wind", "tactic", "Strong wind: no head attack",
       "With strong or gusty wind the head runs and spots: no crews at the head; indirect lines and flanks.",
       when=[("weather.gust_kmh_max", ">=", 40)], maps_to={"mode": "contain"}, source="Fire behaviour doctrine"),
    _c("concentrate-barrier", "tactic", "Concentrate the barrier on the fastest stretches",
       "When the head runs fast, spend the line metres on the few most dangerous stretches instead of spreading them over the whole front.",
       when=[("fire.head_speed_mmin", ">=", 15)], maps_to={"concentration": 3}, source="Indirect attack doctrine"),

    # ---------------------------------------------------------------- what the FireTrace runs measured
    _c("lesson-reserve-killed-attack", "lesson", "Holding units back let a weak fire escape",
       "Penha, old physics: plan B held two engines meant for the head in reserve; the fire escaped (612 ha). With them it was put out at 9 ha.",
       when=[("attack.initial_attack", "==", True)], maps_to={"reserve_share": 0.0}, evidence="FireTrace Penha runs, 2026-10-21"),
    _c("lesson-aircraft-concentrated", "lesson", "Aircraft concentrated on the head did better than spread",
       "Falperra, new physics: all aircraft on the head's corridor gave 199 ha; sending the late ones to the flanks gave 268 ha.",
       when=[("fleet.aircraft", ">=", 3)], maps_to={"aircraft": "head_corridor"}, evidence="FireTrace Falperra runs, 2026-10-21"),
    _c("lesson-defend-whole-run", "lesson", "Defending every patch of houses saved the most houses",
       "Penha, new physics: defending every patch the fire reaches in the run with 5 engines each left 37 buildings hit, against 52 when only the first "
       "patch was defended, for the same burned area.",
       when=[("houses.affected_no_response", ">=", 10)], maps_to={"defend_whole_run": True, "engines_per_zone": 5, "house_zones": 10},
       evidence="FireTrace Penha runs, 2026-10-21"),
    _c("lesson-contain-lost-attack", "lesson", "Forcing containment gave up the initial attack",
       "Penha, new physics, plan B: the LLM commander forced \"contain\" while the engine's test said the first crews could still attack the weak fire. "
       "The initial attack was lost: 829 ha and 44 buildings hit, against 628 ha and 37 with mode \"auto\" and the same house defence (10 zones, the "
       "whole run, 5 engines each). When attack.initial_attack is true, keep mode \"auto\" in both plans and defend the houses on top of the attack.",
       when=[("attack.initial_attack", "==", True)], maps_to={"mode": "auto"}, evidence="FireTrace Penha runs, 2026-10-21 (LLM commander vs rules)"),
    _c("lesson-crown-in-30", "lesson", "The window before crowning is short",
       "Penha and Falperra, new physics: the fire passed direct-attack limits at T+15 to T+30, before most crews arrived; only aircraft and the nearest "
       "units are in time, so they decide the first hour.",
       when=[("fire.crown_onset_min", "<=", 30)], evidence="FireTrace runs, 2026-10-21"),
]
