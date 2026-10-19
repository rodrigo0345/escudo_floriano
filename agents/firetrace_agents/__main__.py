"""Run the agents against a live (or mock) FireTrace Coordination API.

    # 1. start a server first (see README), e.g. the spec's Prism mock:
    #    npx @stoplight/prism-cli mock api-spec/openapi.json

    # 2. run one planning cycle
    python -m firetrace_agents --base-url http://localhost:4010 --simulation-id sim-penanet

    # no server yet? print help / run against FIRETRACE_BASE_URL
    python -m firetrace_agents --help

What it does per run: pulls the fleet, reads the situation, collects each
firefighter agent's decision (with its reason), guards them, prints the plans
A and B it published, and (with ``--simulate``) runs the what-if of plan A via
``POST /plans/{id}/simulate``.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

if __package__ in (None, ""):
    # Direct execution (python agents/firetrace_agents/__main__.py — e.g. the
    # VS Code "Run Python File" button): relative imports need the parent
    # package, so put the package root on sys.path and re-run through it.
    _package_root = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(_package_root))
    import firetrace_agents.__main__

    raise SystemExit(firetrace_agents.__main__.main(sys.argv[1:]))

from .client import FiretraceClient
from .orchestrator import OrchestratorAgent


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="firetrace_agents",
        description="Run one orchestrator planning cycle against a FireTrace API.",
    )
    parser.add_argument("--base-url", default=None, help="API root (default: $FIRETRACE_BASE_URL or http://localhost:8080)")
    parser.add_argument("--simulation-id", default="sim-penanet", help="simulation to base the plans on")
    parser.add_argument("--horizon", type=int, default=60, help="decision horizon, minutes (default 60)")
    parser.add_argument("--location-id", default="guimaraes-concelho", help="plan location id")
    parser.add_argument("--no-publish", action="store_true", help="compose plans but do not POST /plans")
    parser.add_argument("--simulate", action="store_true", help="after publishing plan A, run POST /plans/{id}/simulate")
    parser.add_argument("--plans-json", action="store_true", help="also print the full plan payloads (A and B)")
    args = parser.parse_args(argv)

    base_url = args.base_url or os.environ.get("FIRETRACE_BASE_URL")
    if not base_url:
        parser.print_usage()
        print(
            "\nerror: no server configured. Pass --base-url or set FIRETRACE_BASE_URL.\n"
            "Tip, from the repo root (Prism mock built from api-spec/openapi.json):\n"
            "    npx @stoplight/prism-cli mock api-spec/openapi.json\n"
            "    python -m firetrace_agents --base-url http://localhost:4010",
            file=sys.stderr,
        )
        return 2

    client = FiretraceClient(base_url=base_url)
    orchestrator = OrchestratorAgent(client)

    try:
        capabilities = client.get_capabilities()
        print(f"# {base_url}: {len(capabilities.get('interventions') or [])} interventions announced")
        print(f"# fleet: {orchestrator.pull_fleet()} firefighter units")
        result = orchestrator.run_cycle(
            args.simulation_id,
            horizon_minutes=args.horizon,
            location_id=args.location_id,
            publish=not args.no_publish,
        )
    except Exception as error:  # noqa: BLE001 — the CLI reports and exits non-zero
        print(f"\nerror: {type(error).__name__}: {error}", file=sys.stderr)
        print("Is the server running at this base-url and does /capabilities answer?", file=sys.stderr)
        return 1

    print("\n== Agent decisions (each with its reason) ==")
    for decision in result.decisions:
        print(f"\n[{decision.agent_id}] tier={decision.tier.value} objective={decision.objective}")
        print(f"  reason: {decision.reason}")
    if result.issues:
        print("\n== Orchestrator adjustments ==")
        for issue in result.issues:
            print(f"- [{issue.agent_id}] {issue.proposal_title}: {issue.problem}")

    for label, plan in (("A", result.plan_a), ("B", result.plan_b)):
        published_id = result.published.get(label)
        print(f"\n== Plan {label}: {plan['title']} ==")
        print(f"  actions: {len(plan['actions'])}  id: {published_id or '(not published)'}")
        if args.plans_json:
            print(json.dumps(plan, indent=2, ensure_ascii=False))

    if args.simulate and result.published.get("A"):
        print("\n== What-if of plan A (POST /plans/{id}/simulate) ==")
        try:
            simulation = client.simulate_plan(result.published["A"])
            print(json.dumps({key: simulation.get(key) for key in ("id", "status", "scenarioId")}, ensure_ascii=False))
        except Exception as error:  # noqa: BLE001
            print(f"simulate failed: {type(error).__name__}: {error}", file=sys.stderr)
    client.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
