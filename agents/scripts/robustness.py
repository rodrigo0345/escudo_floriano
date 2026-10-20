"""Do the plans survive a forecast that was wrong?

The agents plan on a baseline simulation, so they "know" exactly where the fire will go. Here the *same* plans are then
evaluated on the same fire with the wind turned or stronger (`POST /simulations` with an inline scenario carrying a
weather event, plus `planId`), and each is compared with the no-response fire under that same wind.

    python agents/scripts/robustness.py --scenario sc-penha --at-minute 30 --at-minute 60 --at-minute 90   # from the repo root

Results go to the screen only; everything it creates is titled `[lab]` and stays in the backend.
"""
from __future__ import annotations

import argparse
import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_plans import baseline_for, pct, stats_of  # noqa: E402

from firetrace_agents import ApiProblem, FiretraceClient, OrchestratorAgent  # noqa: E402
from firetrace_agents.contracts import validate_against_spec  # noqa: E402

SCENARIO_FIELDS = ("name", "description", "locationId", "purpose", "start", "durationMinutes", "ignitions", "initialFire", "weather", "resources", "engine")


def perturbations(duration: int) -> list[tuple[str, list[dict]]]:
    """(label, weather events). Wind direction is where it blows FROM; +deg turns it clockwise."""
    whole = {"start": {"offsetMinutes": 0}, "end": {"offsetMinutes": duration}}
    return [
        ("vento +30° (horário)", [{"type": "wind_shift", "start": {"offsetMinutes": 0}, "deltaDeg": 30}]),
        ("vento −30°", [{"type": "wind_shift", "start": {"offsetMinutes": 0}, "deltaDeg": -30}]),
        ("vento ×1,3", [{"type": "wind_scale", "window": whole, "factor": 1.3}]),
        ("vento ×0,7", [{"type": "wind_scale", "window": whole, "factor": 0.7}]),
    ]


def perturbed_scenario(snapshot: dict, label: str, events: list[dict]) -> dict:
    scenario = {key: copy.deepcopy(snapshot[key]) for key in SCENARIO_FIELDS if key in snapshot}
    weather = scenario.setdefault("weather", {})
    weather["events"] = [*weather.get("events", []), *events]
    scenario["name"] = f"[lab] {snapshot.get('name', 'cenário')} · {label}"
    validate_against_spec("ScenarioInput", scenario)
    return scenario


def simulate(client: FiretraceClient, scenario: dict, label: str, plan_id: str | None = None) -> dict:
    body: dict = {"scenario": scenario, "label": f"[lab] {label}", "kind": "what_if" if plan_id else "baseline"}
    if plan_id:
        body["planId"] = plan_id
    response = client._http.post("/simulations", json=body, headers={"Prefer": "wait=120"})  # noqa: SLF001
    if response.status_code >= 400:
        raise ApiProblem(response.status_code, response.json())
    simulation = response.json()
    if simulation.get("status") in {"queued", "running"}:
        simulation = client.wait_for_simulation(simulation["id"], timeout_seconds=600)
    return simulation


def plan_run(client: FiretraceClient, plan_id: str, baseline_id: str) -> dict:
    """The plan's what-if on the unperturbed fire, waited for if the server answers before it finishes."""
    simulation = client.simulate_plan(plan_id, baseline_simulation_id=baseline_id, wait_seconds=120)
    if simulation.get("status") in {"queued", "running"}:
        simulation = client.wait_for_simulation(simulation["id"], timeout_seconds=600)
    return simulation


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--scenario", default="sc-penha")
    parser.add_argument("--baseline", default=None, help="reuse this baseline simulation id")
    parser.add_argument("--at-minute", type=int, action="append", help="decision instant; repeat for several (default 60)")
    parser.add_argument("--horizon", type=int, default=60)
    args = parser.parse_args(argv)
    instants = args.at_minute or [60]

    client = FiretraceClient(base_url=args.base_url)
    orchestrator = OrchestratorAgent(client)
    try:
        baseline = baseline_for(client, args.scenario, args.baseline)
        snapshot = baseline["scenarioSnapshot"]
        orchestrator.pull_fleet()
        duration = int(snapshot.get("durationMinutes") or 240)
        print(f"{args.scenario}: planos feitos sobre a base {baseline['id']} (sem perturbação: {stats_of(baseline).get('burnedHa')} ha)")
        for at in instants:
            result = orchestrator.run_cycle(baseline["id"], horizon_minutes=args.horizon, at_minute=at, publish=True, title_prefix="[lab] Plano")
            print(f"\n=== decisão aos {at} min (planos {result.published}) ===")
            print(f"{'vento':<24}{'sem resposta':>14}{'plano A':>18}{'plano B':>18}   edifícios (base/A/B)")
            rows = [("real (a previsão)", None, [])] + [(label, label, events) for label, events in perturbations(duration)]
            for name, label, events in rows:
                if label is None:
                    base_stats = stats_of(baseline)
                    outcomes = {v: stats_of(plan_run(client, result.published[v], baseline["id"])) for v in ("A", "B")}
                else:
                    scenario = perturbed_scenario(snapshot, label, events)
                    base_stats = stats_of(simulate(client, scenario, f"{label} sem resposta"))
                    outcomes = {v: stats_of(simulate(client, scenario, f"{label} plano {v}", result.published[v])) for v in ("A", "B")}
                ha = base_stats.get("burnedHa")
                cells = "".join(f"{outcomes[v].get('burnedHa', '-')!s:>11} {pct(outcomes[v].get('burnedHa'), ha):>6}" for v in ("A", "B"))
                buildings = "/".join(str(s.get("buildingsAffected", "-")) for s in (base_stats, outcomes["A"], outcomes["B"]))
                print(f"{name:<24}{ha!s:>14}{cells}   {buildings}")
    except ApiProblem as error:
        print(f"erro da API [{error.code}]: {error}", file=sys.stderr)
        return 1
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
