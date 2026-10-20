"""Runs a firefighting campaign (decide again every stage as the fire evolves) and prints how it went, stage by stage.

    python agents/scripts/run_campaign.py --scenario sc-penha --stage 30 --horizon 60 --policy best      # from the repo root

Compared against two references on the same fire: no response at all, and the "single plan" the agents used to make
(decided once, at --static-minute, with a perfect forecast). Results go to the screen only; nothing is deleted, and the
simulations it creates are titled `[lab]`. Plans are only published with --publish.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_plans import baseline_for  # noqa: E402

from firetrace_agents import ApiProblem, FiretraceClient, OrchestratorAgent  # noqa: E402
from firetrace_agents.campaign import Campaign, StageResult, plan_effects, scenario_at  # noqa: E402

HEADER = f"{'fase':<5}{'T+min':>8}{'plano':>7}{'área ha':>10}{'base':>11}{'controlo':>10}{'Δ ctrl':>7}{'copas ha':>10}{'edif.':>7}{'edif.ctrl':>10}{'ações':>7}{'linhas':>8}{'aviso':>7}  porquê"


def pct(value: float, base: float | None) -> str:
    return f"{(value - base) / base * 100:+.0f}%" if base else "-"


def make_printer(control: dict[int, float], control_buildings: dict[int, int]):
    """One row per stage: the campaign's area against the original baseline and against the chained control (same chain, no response)."""

    def print_stage(stage: StageResult) -> None:
        base = f"{stage.baseline_ha:.0f}" if stage.baseline_ha is not None else "-"
        ctrl = control.get(stage.t1)
        print(
            f"{stage.k:<5}{f'{stage.t0}-{stage.t1}':>8}{stage.plan:>7}{stage.area_ha:>10.0f}{base:>11}{(f'{ctrl:.0f}' if ctrl is not None else '-'):>10}{pct(stage.area_ha, ctrl):>7}"
            f"{stage.crown_ha:>10.0f}{stage.buildings:>7}{control_buildings.get(stage.t1, '-'):>10}{stage.actions:>7}{stage.carried_lines:>8}{stage.issues:>7}  {stage.why}",
            flush=True,
        )
        if stage.life:
            print(f"{'':<5}   ↳ vidas (modelo dos agentes): {stage.life}", flush=True)

    return print_stage


def single_plan(client: FiretraceClient, orchestrator: OrchestratorAgent, baseline: dict, minute: int, horizon: int) -> tuple[str, float] | None:
    """The old way: one decision on the baseline's own forecast, executed over the whole fire. The better of A and B."""
    result = orchestrator.run_cycle(baseline["id"], horizon_minutes=horizon, at_minute=minute, location_id=baseline["scenarioSnapshot"]["locationId"], publish=False)
    best: tuple[str, float] | None = None
    for variant, plan in (("A", result.plan_a), ("B", result.plan_b)):
        scenario = scenario_at(baseline["scenarioSnapshot"], 0, int(baseline["scenarioSnapshot"]["durationMinutes"]), perimeter=None, interventions=plan_effects(plan), name="[lab] plano único")
        sim = client.run_scenario(scenario, label=f"[lab] plano único {variant}")
        area = float((sim.get("stats") or {}).get("burnedHa") or 0.0) if sim.get("status") == "succeeded" else float("inf")
        if best is None or area < best[1]:
            best = (variant, area)
    return best


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--scenario", default="sc-penha")
    parser.add_argument("--baseline", default=None, help="reuse this baseline simulation id")
    parser.add_argument("--stage", type=int, default=30, help="minutes between decisions (default 30)")
    parser.add_argument("--horizon", type=int, default=60, help="how far ahead the agents look (default 60)")
    parser.add_argument("--policy", choices=["A", "B", "best"], default="best")
    parser.add_argument("--forecast-wind-shift", type=float, default=0.0, help="degrees the FORECAST wind is wrong by (the execution uses the real one)")
    parser.add_argument("--start", type=int, default=0, help="minute the response starts (default 0: at the ignition)")
    parser.add_argument("--until", type=int, default=None)
    parser.add_argument("--static-minute", type=int, default=60, help="decision minute of the single-plan reference")
    parser.add_argument("--no-static", action="store_true")
    parser.add_argument("--publish", action="store_true", help="also publish the chosen plan of each stage (POST /plans)")
    parser.add_argument("--unlimited", action="store_true", help="no limit on the line each unit can build (what the first campaign did)")
    parser.add_argument("--concentration", default="1,3,6", help="candidates: on how many of the most dangerous sectors to spend the line (comma list; 0 = units spread over the front)")
    parser.add_argument("--building-zones", default="0", help="candidates: how many patches of houses the fire engines defend (comma list; 0 = none, e.g. 0,10)")
    parser.add_argument("--no-travel", action="store_true", help="every unit is on site at minute 0 (what the campaigns assumed before the routing was used)")
    args = parser.parse_args(argv)

    client = FiretraceClient(base_url=args.base_url)
    orchestrator = OrchestratorAgent(client)
    try:
        baseline = baseline_for(client, args.scenario, args.baseline)
        if baseline.get("status") != "succeeded":
            print(f"baseline {baseline.get('id')} is {baseline.get('status')}", file=sys.stderr)
            return 1
        total = int(baseline["scenarioSnapshot"]["durationMinutes"])
        base_final = float((baseline.get("stats") or {}).get("burnedHa") or 0.0)
        team = orchestrator.pull_fleet()
        mode = "sem limite de linha" if args.unlimited else f"com limite de linha, candidatos de concentração {args.concentration}"
        print(f"=== {args.scenario} · base {baseline['id']} · {team} agentes · decide de {args.stage} em {args.stage} min · horizonte {args.horizon} min · {mode}"
              + (f" · previsão com vento errado {args.forecast_wind_shift:+.0f}°" if args.forecast_wind_shift else "") + " ===")
        print(HEADER)
        common = dict(stage_minutes=args.stage, horizon_minutes=args.horizon, policy=args.policy, forecast_wind_shift_deg=args.forecast_wind_shift,
                      start_minute=args.start, until_minute=args.until, capacity=not args.unlimited, concentrations=tuple(int(c) for c in args.concentration.split(",")),
                      building_zones=tuple(int(z) for z in args.building_zones.split(",")), travel=not args.no_travel)
        # the control first: the same chain of stages with no response (it carries the small error that restarting from an outline adds)
        control = Campaign(client, orchestrator, baseline, response=False, **common).run()
        campaign = Campaign(client, orchestrator, baseline, publish=args.publish, **common)
        result = campaign.run(on_stage=make_printer({s.t1: s.area_ha for s in control.stages}, {s.t1: s.buildings for s in control.stages}))
        if result.stopped:
            print(f"  (parou: {result.stopped})")
        if result.final_ha is not None:
            ctrl_final = control.final_ha
            print(f"\nsem resposta (corrida inteira) .... {base_final:.0f} ha ({total} min)")
            print(f"sem resposta (encadeada, controlo)  {ctrl_final:.0f} ha" if ctrl_final is not None else "")
            print(f"campanha ......................... {result.final_ha:.0f} ha  {pct(result.final_ha, ctrl_final)} face ao controlo  ({pct(result.final_ha, base_final)} face à corrida inteira)")
        if not args.no_static:
            reference = single_plan(client, orchestrator, baseline, args.static_minute, args.horizon)
            if reference:
                print(f"plano único (A/B melhor, decidido aos {args.static_minute} min, previsão perfeita) .. {reference[1]:.0f} ha  {pct(reference[1], base_final)}  [plano {reference[0]}]")
    except ApiProblem as error:
        print(f"erro da API [{error.code}]: {error}", file=sys.stderr)
        return 1
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
