"""Runs the agents against a baseline fire in several "modes" and prints how each changes the outcome.

For every mode the orchestrator builds its team, the agents decide, plans A and B are validated and published
(`POST /plans`), and each plan is simulated as a what-if (`POST /plans/{id}/simulate`). Results go to the screen only.

    python agents/scripts/compare_plans.py --scenario sc-penha --at-minute 60      # from the repo root

Modes: both plans with the full fleet, then A and B again without helicopters / trucks / squads.
A "delayed response" mode is deliberately absent: the backend ignores an intervention's start time (same result
whether it starts at +0, +90 or +200 min), so it cannot be compared.

Everything it publishes is titled `[lab] ...` and stays in the backend (nothing is deleted).
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from firetrace_agents import ApiProblem, FiretraceClient, OrchestratorAgent  # noqa: E402
from firetrace_agents.tiers import FirefighterTier  # noqa: E402

METRICS = [("burnedHa", "ha queimados"), ("crownFireHa", "copas ha"), ("buildingsAffected", "edifícios")]
MODES: list[tuple[str, tuple[FirefighterTier, ...]]] = [
    ("frota completa", ()),
    ("sem helicópteros", (FirefighterTier.HELICOPTER,)),
    ("sem carros", (FirefighterTier.TRUCK,)),
    ("sem esquadras", (FirefighterTier.SQUAD,)),
]


def baseline_for(client: FiretraceClient, scenario: str, baseline_id: str | None) -> dict:
    if baseline_id:
        return client.get_simulation(baseline_id)
    response = client._http.post(  # noqa: SLF001 — no client method for creating a simulation yet
        "/simulations",
        json={"scenarioId": scenario, "kind": "baseline", "label": f"[lab] baseline {scenario}"},
        headers={"Prefer": "wait=120"},
    )
    response.raise_for_status()
    simulation = response.json()
    if simulation.get("status") in {"queued", "running"}:
        simulation = client.wait_for_simulation(simulation["id"], timeout_seconds=600)
    return simulation


def stats_of(simulation: dict) -> dict:
    return simulation.get("stats") or {}


def pct(value: float | None, base: float | None) -> str:
    if value is None or not base:
        return "   -"
    return f"{(value - base) / base * 100:+4.0f}%"


def cell(stats: dict, base: dict, key: str) -> str:
    value = stats.get(key)
    return f"{value if value is not None else '-':>8} {pct(value, base.get(key)):>6}"


def run_mode(client: FiretraceClient, orchestrator: OrchestratorAgent, baseline_id: str, at_minute: int, exclude: tuple[FirefighterTier, ...], horizon: int):
    team = orchestrator.pull_fleet(exclude_tiers=exclude)
    if team == 0:
        return None, {}
    result = orchestrator.run_cycle(baseline_id, horizon_minutes=horizon, at_minute=at_minute, publish=True, title_prefix="[lab] Plano")
    outcomes = {}
    for variant in ("A", "B"):
        plan_id = result.published.get(variant)
        if not plan_id:
            outcomes[variant] = ({}, "não publicado")
            continue
        simulation = client.simulate_plan(plan_id, baseline_simulation_id=baseline_id, wait_seconds=120)
        if simulation.get("status") in {"queued", "running"}:
            simulation = client.wait_for_simulation(simulation["id"], timeout_seconds=600)
        note = "" if simulation.get("status") == "succeeded" else f"simulação {simulation.get('status')}"
        outcomes[variant] = (stats_of(simulation), note)
    return result, {"team": team, "outcomes": outcomes}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=None, help="API root incl. /api/v1 (default: $FIRETRACE_BASE_URL or http://localhost:8080/api/v1)")
    parser.add_argument("--scenario", action="append", help="scenario id; repeat for several (default: sc-penha)")
    parser.add_argument("--baseline", default=None, help="reuse this baseline simulation id (only with one --scenario)")
    parser.add_argument("--at-minute", type=int, default=60, help="decision instant, minutes since ignition (default 60)")
    parser.add_argument("--horizon", type=int, default=60)
    args = parser.parse_args(argv)
    scenarios = args.scenario or ["sc-penha"]

    client = FiretraceClient(base_url=args.base_url)
    orchestrator = OrchestratorAgent(client)
    try:
        for scenario in scenarios:
            baseline = baseline_for(client, scenario, args.baseline if len(scenarios) == 1 else None)
            if baseline.get("status") != "succeeded":
                print(f"{scenario}: baseline {baseline.get('id')} is {baseline.get('status')}; skipped", file=sys.stderr)
                continue
            base = stats_of(baseline)
            header = "".join(f"{label:>15}" for _key, label in METRICS)
            print(f"\n=== {scenario}  (base {baseline['id']}, decisão aos {args.at_minute} min) ===")
            print(f"{'':<34}{'agentes':>8}{header}")
            print(f"{'sem resposta (base)':<34}{'-':>8}" + "".join(f"{base.get(k, '-')!s:>15}" for k, _l in METRICS))
            for name, exclude in MODES:
                result, data = run_mode(client, orchestrator, baseline["id"], args.at_minute, exclude, args.horizon)
                if result is None:
                    print(f"{'  ' + name + ' (sem agentes)':<34}")
                    continue
                for variant in ("A", "B"):
                    stats, note = data["outcomes"][variant]
                    row = "".join(f"{cell(stats, base, key):>15}" for key, _l in METRICS)
                    print(f"{'  ' + name + ' · plano ' + variant:<34}{data['team']:>8}{row}  {note}")
                kinds = sorted({m.tier.value for m in result.decisions})
                actions = f"A={len(result.plan_a['actions'])} B={len(result.plan_b['actions'])} ações"
                print(f"{'':<34}{'':>8}  escalões: {', '.join(kinds)}; {actions}; avisos do validador: {sum(len(v.get('issues', [])) for v in result.validation.values())}")
    except ApiProblem as error:
        print(f"erro da API [{error.code}]: {error}", file=sys.stderr)
        return 1
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
