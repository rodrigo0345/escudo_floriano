"""Plans A and B for one baseline through the service's own pipeline, with the strategy chosen by the LLM commander (AGENTS_COMMANDER=llm and the
model/key from the environment), then the what-if run of each published plan, so they show in the frontend under that baseline.

    docker compose exec agents python scripts/publish_with_commander.py <baseline sim id> [replan_minutes]

``replan_minutes`` 0 (default) skips the 45-min re-plans for a quick check; the service itself runs them.
"""
from __future__ import annotations

import logging
import sys
import time

from firetrace_agents.alternatives import HOUSE_ZONES_FOR_B, build_alternatives
from firetrace_agents.client import FiretraceClient
from firetrace_agents.commander import commander_from_env
from firetrace_agents.orchestrator import OrchestratorAgent


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", stream=sys.stdout)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sim, replan = argv[0], int(argv[1]) if len(argv) > 1 else 0
    commander = commander_from_env()
    if commander is None:
        print("AGENTS_COMMANDER is not 'llm': nothing to do")
        return 1
    client = FiretraceClient()
    orchestrator = OrchestratorAgent(client)
    orchestrator.pull_fleet()
    snapshot = client.get_simulation(sim)["scenarioSnapshot"]
    started = time.monotonic()
    out = build_alternatives(orchestrator, client, sim, publish=True, house_zones=HOUSE_ZONES_FOR_B, horizon_minutes=60, location_id=snapshot["locationId"],
                             title_prefix="Plano", at_minute=0, stage_minutes=30, concentration=6, replan_minutes=replan, max_waves=3, candidates=1,
                             commander=commander)
    for variant, evaluation in (("A", out.eval_a), ("B", out.eval_b)):
        print(f"{variant}: {evaluation.line() if evaluation else 'no result'}")
    for variant, plan_id in out.published.items():
        run = client.simulate_plan(plan_id, baseline_simulation_id=sim, wait_seconds=None)
        print(f"{variant}: published {plan_id}, what-if {run.get('id')}")
    for problem in out.issues:
        print("issue:", problem)
    print(f"done in {time.monotonic() - started:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
