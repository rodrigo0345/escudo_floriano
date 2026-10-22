# syntax=docker/dockerfile:1
# The agents as a service: watches the API for finished baseline simulations and publishes plans A and B with their what-if runs.
# Build context is this folder (the repository's .dockerignore leaves agents/ out of the root context):
#   docker build -t firetrace-agents agents
# The contract (api-spec/openapi.json) is mounted at run time, as the backend does, and read through FIRETRACE_SPEC.

FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY firetrace_agents ./firetrace_agents
# the [llm] extra is the LLM commander (LangChain + LangGraph); the service only uses it when AGENTS_COMMANDER=llm, and runs on the rules if the key or model is missing
RUN pip install --no-cache-dir ".[llm]"
# the demo resources the service registers on start (AGENTS_SEED_DEMO), and the scripts for `docker compose exec agents python scripts/...`
COPY scripts ./scripts
ENV PYTHONUNBUFFERED=1 \
    FIRETRACE_BASE_URL=http://backend:8080/api/v1 \
    FIRETRACE_SPEC=/app/api-spec/openapi.json
CMD ["python", "-m", "firetrace_agents.watcher"]
