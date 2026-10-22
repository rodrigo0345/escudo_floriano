"""Joint operations: the corporations work together on the ground, not each on its own island.

In the field a fire is not fought by one corporation: the Bombeiros attack and defend, the GNR keeps the road to them open and the crowd off it, the INEM waits
behind the crews that take the risk, and Proteção Civil warns and moves the people whose houses the Bombeiros defend. The plan used to give each corporation its
own actions side by side. Here the actions that belong together are **linked**: each lists the other corporation in ``supportingOrganizationIds``, says in its
rationale who it works with and where, and shares an operation label (``Operação conjunta [J3] · GNR + Bombeiros``, in ``description``) the map and the list group by.

The pairs, by how near the actions are:

* **Bombeiros + GNR**: a crew or a house defence and the nearest GNR checkpoint (it keeps the road open to the engines and the public out of the way);
* **GNR + Proteção Civil**: an evacuation and the nearest GNR checkpoint (it clears the way out and stops anyone driving back in);
* **Bombeiros + INEM**: an ambulance standby and the crews it covers;
* **Bombeiros + Proteção Civil**: a house defence and the warning to the people in it (the alert of the same patch of houses).
"""
from __future__ import annotations

from typing import Any

from .sectors import distance_m

GNR_REACH_M = 2500.0  # a checkpoint this near an action is "its" checkpoint
INEM_COVER_M = 3500.0  # an ambulance standby covers the crews within this
ALERT_REACH_M = 1500.0


def point_of(action: dict[str, Any]) -> dict[str, float] | None:
    """Where an action happens: its position, anchor, staging area, area or first effect."""
    for point in (action.get("position"), action.get("anchorPoint"), (action.get("stagingArea") or {}).get("position"), ((action.get("positions") or [{}])[0] or {}).get("position"),
                  ((action.get("checkpoints") or [{}])[0] or {}).get("position")):
        if isinstance(point, dict) and point.get("lat") is not None:
            return {"lat": float(point["lat"]), "lon": float(point["lon"])}
    geometries = [action.get("area"), action.get("line"), *[e.get("geometry") for e in action.get("simulationEffects") or []]]
    for geometry in geometries:
        if not isinstance(geometry, dict):
            continue
        kind, coords = geometry.get("type"), geometry.get("coordinates") or []
        points = coords if kind == "LineString" else coords[0] if kind == "Polygon" and coords else []
        points = [p for p in points if p and len(p) >= 2]
        if points:
            return {"lat": sum(p[1] for p in points) / len(points), "lon": sum(p[0] for p in points) / len(points)}
    return None


def _link(action: dict[str, Any], partner_org: str, label: str, sentence: str) -> None:
    support = list(action.get("supportingOrganizationIds") or [])
    if partner_org and partner_org != action.get("organizationId") and partner_org not in support:
        support.append(partner_org)
    if support:
        action["supportingOrganizationIds"] = support
    if label not in str(action.get("description") or ""):
        action["description"] = f"{action.get('description') + ' · ' if action.get('description') else ''}{label}"
    if sentence not in str(action.get("rationale") or ""):
        action["rationale"] = f"{action.get('rationale') or ''} {sentence}".strip()


def link_organizations(actions: list[dict[str, Any]], *, gnr_org: str, civil_org: str, medical_org: str) -> int:
    """Link the actions that belong together (in place); returns how many operations (pairs of linked actions) were made."""
    points = {str(a["id"]): point_of(a) for a in actions}
    posts = [a for a in actions if a.get("type") == "traffic_control_point" and a.get("organizationId") == gnr_org and points.get(str(a["id"]))]
    fire = [a for a in actions if a.get("type") in ("fire_attack", "structure_protection", "dispatch_units") and a.get("organizationId") not in (gnr_org, medical_org) and points.get(str(a["id"]))]
    count = 0

    def nearest(origin: dict[str, float], candidates: list[dict[str, Any]], reach: float) -> tuple[dict[str, Any], float] | None:
        best = min(((c, distance_m(origin["lat"], origin["lon"], points[str(c["id"])]["lat"], points[str(c["id"])]["lon"])) for c in candidates if points.get(str(c["id"]))), key=lambda t: t[1], default=None)
        return best if best is not None and best[1] <= reach else None

    def pair(a: dict[str, Any], b: dict[str, Any], label_orgs: str, a_text: str, b_text: str) -> None:
        nonlocal count
        count += 1
        label = f"Operação conjunta [J{count}] · {label_orgs}"
        _link(a, str(b.get("organizationId") or ""), label, a_text)
        _link(b, str(a.get("organizationId") or ""), label, b_text)

    # Bombeiros + GNR: every crew and house defence with a checkpoint near it
    for action in fire:
        found = nearest(points[str(action["id"])], posts, GNR_REACH_M)
        if found is None:
            continue
        post, meters = found
        pair(action, post, "GNR + Bombeiros",
             f"Em operação conjunta com a GNR: o controlo de trânsito a ~{meters:.0f} m mantém a estrada livre para os meios e o público fora da zona.",
             f"Em operação conjunta com os Bombeiros: protege o acesso das viaturas que trabalham a ~{meters:.0f} m daqui.")
    # GNR + Proteção Civil: every evacuation (its way out is cleared by the nearest checkpoint)
    for action in actions:
        if action.get("type") != "evacuation" or not points.get(str(action["id"])):
            continue
        found = nearest(points[str(action["id"])], posts, GNR_REACH_M * 1.5)
        if found is None:
            continue
        post, meters = found
        pair(action, post, "GNR + Proteção Civil",
             f"Em operação conjunta com a GNR: o controlo de trânsito a ~{meters:.0f} m abre a saída e impede quem fugiu de voltar.",
             "Em operação conjunta com a Proteção Civil: garante a via de saída de quem é evacuado.")
    # Bombeiros + INEM: every ambulance standby with the crews it covers
    for action in actions:
        if action.get("type") != "medical_standby" or not points.get(str(action["id"])):
            continue
        covered = [f for f in fire if (p := points.get(str(f["id"]))) and distance_m(points[str(action["id"])]["lat"], points[str(action["id"])]["lon"], p["lat"], p["lon"]) <= INEM_COVER_M]
        if not covered:
            continue
        first = min(covered, key=lambda f: distance_m(points[str(action["id"])]["lat"], points[str(action["id"])]["lon"], points[str(f["id"])]["lat"], points[str(f["id"])]["lon"]))
        pair(action, first, "INEM + Bombeiros",
             f"Em operação conjunta com os Bombeiros: cobre {len(covered)} equipas no terreno, a poucos minutos de qualquer uma.",
             "Em operação conjunta com o INEM: a ambulância de prevenção está atrás desta equipa, fora do alcance do fogo.")
    # Bombeiros + Proteção Civil: every house defence with the warning to its people
    alerts = [a for a in actions if a.get("type") == "public_alert" and points.get(str(a["id"]))]
    for action in fire:
        if action.get("type") != "structure_protection":
            continue
        found = nearest(points[str(action["id"])], alerts, ALERT_REACH_M)
        if found is None:
            continue
        alert, _meters = found
        pair(action, alert, "Proteção Civil + Bombeiros",
             "Em operação conjunta com a Proteção Civil: as pessoas destas casas foram avisadas e saem ou ficam abrigadas enquanto as viaturas molham os edifícios.",
             "Em operação conjunta com os Bombeiros: as viaturas defendem as casas de quem foi avisado.")
    return count
