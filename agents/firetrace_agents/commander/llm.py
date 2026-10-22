"""A thin client for an OpenAI-compatible chat-completions API (OpenAI, OpenRouter, a local server...), configured by environment variables.

``AGENTS_LLM_BASE_URL`` (default ``https://api.openai.com/v1``), ``AGENTS_LLM_MODEL`` (the provider's exact model id) and the key in
``AGENTS_LLM_API_KEY`` or ``OPENAI_API_KEY``. The key is read from the environment only: never put it in code or in a committed file.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Any

import httpx

DEFAULT_BASE_URL = "https://api.openai.com/v1"


class LlmError(Exception):
    """The provider failed or answered with something that is not a JSON object. ``retryable``: whether asking again could help (a bad answer
    can be corrected; an unreachable provider, no credits or a rejected key cannot)."""

    def __init__(self, message: str, *, retryable: bool = True) -> None:
        super().__init__(message)
        self.retryable = retryable


@dataclass
class LlmClient:
    base_url: str
    model: str
    api_key: str
    timeout_s: float = 90.0

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> "LlmClient | None":
        """A client when a model and a key are configured, else ``None`` (the commander then uses the rules)."""
        e = os.environ if env is None else env
        model, key = e.get("AGENTS_LLM_MODEL", "").strip(), (e.get("AGENTS_LLM_API_KEY") or e.get("OPENAI_API_KEY") or "").strip()
        if not model or not key:
            return None
        return cls(e.get("AGENTS_LLM_BASE_URL", DEFAULT_BASE_URL).rstrip("/"), model, key, float(e.get("AGENTS_LLM_TIMEOUT_S", "90")))

    def complete_json(self, system: str, user: str) -> dict[str, Any]:
        """One chat completion that must answer a JSON object. JSON mode is asked for; a provider that refuses it is asked again without it."""
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}]
        body: dict[str, Any] = {"model": self.model, "messages": messages, "response_format": {"type": "json_object"}}
        response = self._post(body)
        if response.status_code == 400 and "response_format" in response.text:
            body.pop("response_format")
            response = self._post(body)
        if response.status_code >= 400:
            # 401/403: the key; 402/429 with a quota or billing code: no credits; 404: the model id. A 429 rate limit or a 5xx may pass.
            account = response.status_code in (401, 402, 403, 404) or any(w in response.text for w in ("insufficient_quota", "credit_balance", "billing"))
            raise LlmError(f"provider answered HTTP {response.status_code}: {response.text[:300]}", retryable=not account)
        try:
            content = response.json()["choices"][0]["message"]["content"]
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise LlmError(f"unexpected provider answer: {response.text[:300]}") from error
        return parse_json_object(content or "")

    def _post(self, body: dict[str, Any]) -> httpx.Response:
        try:
            return httpx.post(f"{self.base_url}/chat/completions", json=body, timeout=self.timeout_s,
                              headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"})
        except httpx.HTTPError as error:
            raise LlmError(f"provider unreachable: {type(error).__name__}: {error}", retryable=False) from error


def parse_json_object(text: str) -> dict[str, Any]:
    """The JSON object in a model's answer (code fences and text around it are tolerated)."""
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise LlmError(f"no JSON object in the answer: {text[:200]}")
    try:
        value = json.loads(text[start:end + 1])
    except ValueError as error:
        raise LlmError(f"the answer is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise LlmError("the answer is not a JSON object")
    return value
