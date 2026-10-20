"""The evaluation matrix: does the campaign help, and how much does each part of the fleet matter?

For every scenario and every moment the response starts, one chained control (the same chain of stages with no response) and one
campaign per fleet variant (full fleet, without helicopters, without trucks, without squads). Each row is the campaign against *its
own* control, so the small error of restarting from an outline cancels out. A summary at the end gives the median over scenarios.

    python agents/scripts/evaluate.py                                   # 5 scenarios x starts 0 and 90 x 3 variants, about half an hour
    python agents/scripts/evaluate.py --scenarios sc-penha --starts 60  # one cell

Results go to the screen only (rows appear as they finish); the simulations it creates are titled `[lab]` and nothing is deleted.
Every number inherits the limits in the README: the fleet starts on site with no water, fatigue or travel time, and lives are the agents' model.
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from compare_plans import baseline_for  # noqa: E402

from firetrace_agents import ApiProblem, FiretraceClient, OrchestratorAgent  # noqa: E402
from firetrace_agents.campaign import Campaign, CampaignResult  # noqa: E402
from firetrace_agents.tiers import FirefighterTier  # noqa: E402

DEFAULT_SCENARIOS = "sc-falperra,sc-penha,sc-santa-marinha,sc-sao-bento,sc-sao-sabagudo"
VARIANTS: dict[str, tuple[FirefighterTier, ...]] = {
    "full": (),
    "no-heli": (FirefighterTier.HELICOPTER,),
    "no-trucks": (FirefighterTier.TRUCK,),
    "no-squads": (FirefighterTier.SQUAD,),
}
HEADER = f"{'cenário':<20}{'início':>7}{'frota':>11}{'agentes':>8}{'controlo':>10}{'campanha':>10}{'Δ':>7}{'edif. ctrl':>11}{'edif.':>6}  vidas (pior fase)"


def pct(value: float, base: float) -> str:
    return f"{(value - base) / base * 100:+.0f}%" if base else "-"


def worst_life(result: CampaignResult) -> str:
    reports = [s.life_report for s in result.stages if s.life_report is not None]
    if not reports:
        return "ninguém em risco"
    r = max(reports, key=lambda x: x.people_at_risk)
    return f"{r.line()}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--base-url", default=None)
    parser.add_argument("--scenarios", default=DEFAULT_SCENARIOS)
    parser.add_argument("--starts", default="0,90", help="minutes after the ignition at which the response starts")
    parser.add_argument("--variants", default="full,no-heli,no-trucks", help=f"any of {','.join(VARIANTS)}")
    parser.add_argument("--stage", type=int, default=30)
    parser.add_argument("--horizon", type=int, default=60)
    parser.add_argument("--concentration", type=int, default=6, help="barrier concentration (6 was the best candidate in every stage tried)")
    args = parser.parse_args(argv)
    scenarios = args.scenarios.split(",")
    starts = [int(s) for s in args.starts.split(",")]
    variants = args.variants.split(",")

    client = FiretraceClient(base_url=args.base_url)
    orchestrator = OrchestratorAgent(client)
    rows: list[dict] = []
    began = time.time()
    try:
        print(HEADER, flush=True)
        for scenario in scenarios:
            baseline = baseline_for(client, scenario, None)
            if baseline.get("status") != "succeeded":
                print(f"{scenario}: baseline {baseline.get('status')}; skipped", file=sys.stderr)
                continue
            common = dict(stage_minutes=args.stage, horizon_minutes=args.horizon, policy="A", concentrations=(args.concentration,), capacity=True)
            for start in starts:
                orchestrator.pull_fleet()
                control = Campaign(client, orchestrator, baseline, response=False, start_minute=start, **common).run()
                if control.final_ha is None:
                    continue
                ctrl_buildings = control.stages[-1].buildings
                for name in variants:
                    team = orchestrator.pull_fleet(exclude_tiers=VARIANTS[name])
                    if team == 0:
                        continue
                    try:
                        result = Campaign(client, orchestrator, baseline, start_minute=start, **common).run()
                    except ApiProblem as error:
                        print(f"{scenario:<20}{start:>7}{name:>11}  erro da API [{error.code}]", flush=True)
                        continue
                    if result.final_ha is None:
                        continue
                    delta = (result.final_ha - control.final_ha) / control.final_ha * 100 if control.final_ha else 0.0
                    rows.append(dict(scenario=scenario, start=start, variant=name, delta=delta))
                    print(
                        f"{scenario:<20}{start:>7}{name:>11}{team:>8}{control.final_ha:>10.0f}{result.final_ha:>10.0f}{pct(result.final_ha, control.final_ha):>7}"
                        f"{ctrl_buildings:>11}{result.stages[-1].buildings:>6}  {worst_life(result)}",
                        flush=True,
                    )
        print("\n=== mediana da variação da área ardida face ao controlo, sobre os cenários ===")
        print(f"{'início':>7}" + "".join(f"{name:>12}" for name in variants))
        for start in starts:
            cells = []
            for name in variants:
                values = [r["delta"] for r in rows if r["start"] == start and r["variant"] == name]
                cells.append(f"{statistics.median(values):+.0f}% (n={len(values)})" if values else "-")
            print(f"{start:>7}" + "".join(f"{c:>12}" for c in cells))
        print(f"\n({(time.time() - began) / 60:.0f} min)")
    finally:
        client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
