#!/usr/bin/env python3
"""JSONL bridge between Bees and Hermes AIAgent."""

from __future__ import annotations

import argparse
import dataclasses
import inspect
import json
import math
import os
import re
import sys
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import datetime
from pathlib import Path
from typing import Any

PROTOCOL_OUT = sys.stdout
PROTOCOL_LOCK = threading.Lock()

# Cap on concurrent AIAgent.run_conversation calls (chat + judge).
AGENT_RUN_LIMIT = int(os.environ.get("HERMES_AGENT_RUN_LIMIT", "10"))
AGENT_SEMAPHORE = threading.BoundedSemaphore(AGENT_RUN_LIMIT)
ACTIVE_TASKS: dict[str, str] = {}
ACTIVE_TASKS_LOCK = threading.Lock()

ALLOWED_REASONING = {"none", "minimal", "low", "medium", "high", "xhigh"}
KNOWN_PROVIDER_PREFIXES = {
    "anthropic",
    "openai",
    "openai-codex",
    "copilot",
    "deepseek",
    "gemini",
    "google",
    "kimi",
    "kimi-coding",
    "minimax",
    "mistral",
    "mistralai",
    "moonshotai",
    "nous",
    "ollama",
    "ollama-cloud",
    "openrouter",
    "qwen",
    "x-ai",
    "xai",
    "z-ai",
    "zai",
}

_AGENT_DIR: Path | None = None
_IMPORTS_READY = False
_IMPORTS_LOCK = threading.Lock()
_AIAgent: Any = None
_AIAgent_PARAMS: set[str] = set()
_SessionDB: Any = None
_CRON_TICKER_STARTED = False
_CRON_TICKER_LOCK = threading.Lock()
_CONFIG_CACHE: dict[str, Any] | None = None
_CONFIG_MTIME: float = 0.0
_MODEL_EXECUTOR = ThreadPoolExecutor(max_workers=1)
try:
    _MODEL_LIST_CACHE_TTL_SECONDS = max(0.0, float(os.environ.get("BEES_MODEL_LIST_CACHE_TTL_SECONDS", "60")))
except ValueError:
    _MODEL_LIST_CACHE_TTL_SECONDS = 60.0


@dataclasses.dataclass
class _ModelListCache:
    data: dict[str, Any]
    config_mtime: float
    expires_at: float


_MODEL_LIST_CACHE: _ModelListCache | None = None
_MODEL_LIST_CACHE_LOCK = threading.Lock()


class WorkerError(Exception):
    def __init__(self, message: str, code: str = "worker_error", hint: str | None = None):
        super().__init__(message)
        self.code = code
        self.hint = hint


def _missing_agent_hint() -> str:
    if os.name == "nt":
        return "Set HERMES_AGENT_DIR or install Hermes into %LOCALAPPDATA%\\hermes\\hermes-agent."
    return "Set HERMES_AGENT_DIR or install Hermes into ~/.hermes/hermes-agent."


def _send(payload: dict[str, Any]) -> None:
    with PROTOCOL_LOCK:
        PROTOCOL_OUT.write(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n")
        PROTOCOL_OUT.flush()


def _result(request_id: str, data: dict[str, Any]) -> None:
    _send({"id": request_id, "type": "result", "data": data})


def _error_payload(exc: BaseException) -> dict[str, str]:
    if isinstance(exc, WorkerError):
        payload = {"message": str(exc), "code": exc.code}
        if exc.hint:
            payload["hint"] = exc.hint
        return payload

    message = str(exc) or exc.__class__.__name__
    lower = message.lower()
    code = "worker_error"
    hint = None

    if isinstance(exc, ImportError) or "no module named" in lower:
        code = "import_error"
        hint = "Use HERMES_PYTHON=~/.hermes/hermes-agent/venv/bin/python."
    elif "unauthorized" in lower or "authentication" in lower or "401" in lower or "api key" in lower:
        code = "auth_error"
        hint = "Run hermes model or update ~/.hermes/config.yaml credentials."
    elif "rate limit" in lower or "429" in lower:
        code = "rate_limit"
        hint = "Retry later or switch provider/model."
    elif "quota" in lower or "credit" in lower or "insufficient" in lower:
        code = "quota_exhausted"
        hint = "Top up provider account or switch provider/model."
    elif "model" in lower and ("not found" in lower or "rejected" in lower or "invalid" in lower):
        code = "model_error"
        hint = "Pick another model from the model menu."

    payload = {"message": message, "code": code}
    if hint:
        payload["hint"] = hint
    return payload


def _send_error(request_id: str, exc: BaseException) -> None:
    _send({"id": request_id, "type": "error", "error": _error_payload(exc)})


def _resolve_agent_dir_from_hermes_cli() -> Path | None:
    import shutil

    hermes_bin = shutil.which("hermes")
    if not hermes_bin:
        return None
    try:
        real = Path(hermes_bin).resolve()
        if os.name == "nt":
            shim_candidate = real.parent.parent / "hermes-agent"
            if (shim_candidate / "run_agent.py").exists():
                return shim_candidate
        # Typical layout: <agent-dir>/venv/bin/hermes
        candidate = real.parent.parent.parent
        if (candidate / "run_agent.py").exists():
            return candidate
    except OSError:
        pass
    return None


def _discover_agent_dir() -> Path:
    candidates: list[Path] = []

    env_dir = os.environ.get("HERMES_AGENT_DIR", "").strip()
    if env_dir:
        candidates.append(Path(env_dir).expanduser())

    hermes_home = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))).expanduser()
    candidates.append(hermes_home / "hermes-agent")
    candidates.append(Path.home() / ".hermes" / "hermes-agent")
    if os.name == "nt":
        local_app_data = os.environ.get("LOCALAPPDATA", "").strip()
        if local_app_data:
            candidates.append(Path(local_app_data) / "hermes" / "hermes-agent")

    seen: set[str] = set()
    for candidate in candidates:
        try:
            resolved = candidate.resolve()
        except OSError:
            resolved = candidate
        key = str(resolved)
        if key in seen:
            continue
        seen.add(key)
        if (resolved / "run_agent.py").exists():
            return resolved

    cli_dir = _resolve_agent_dir_from_hermes_cli()
    if cli_dir:
        return cli_dir

    raise WorkerError(
        "Hermes agent source not found.",
        code="hermes_not_found",
        hint=_missing_agent_hint(),
    )


def _ensure_imports() -> None:
    if _IMPORTS_READY:
        return
    with _IMPORTS_LOCK:
        if _IMPORTS_READY:
            return
        _ensure_imports_unlocked()


def _ensure_imports_unlocked() -> None:
    global _AGENT_DIR, _IMPORTS_READY, _AIAgent, _AIAgent_PARAMS, _SessionDB

    _AGENT_DIR = _discover_agent_dir()
    agent_dir_str = str(_AGENT_DIR)
    if agent_dir_str not in sys.path:
        sys.path.append(agent_dir_str)

    try:
        from run_agent import AIAgent
    except ImportError as exc:
        raise WorkerError(
            f"Could not import Hermes AIAgent: {exc}",
            code="import_error",
            hint="Use HERMES_PYTHON=~/.hermes/hermes-agent/venv/bin/python.",
        ) from exc

    _AIAgent = AIAgent
    _AIAgent_PARAMS = set(inspect.signature(AIAgent.__init__).parameters)
    try:
        from hermes_state import SessionDB
        _SessionDB = SessionDB
    except Exception:
        _SessionDB = None

    _IMPORTS_READY = True


def _load_config() -> dict[str, Any]:
    global _CONFIG_CACHE, _CONFIG_MTIME
    _ensure_imports()

    config_path = Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "config.yaml"
    try:
        mtime = config_path.stat().st_mtime
    except OSError:
        mtime = 0.0

    if _CONFIG_CACHE is not None and mtime == _CONFIG_MTIME:
        return _CONFIG_CACHE

    try:
        from hermes_cli.config import load_config

        cfg = load_config()
        result = cfg if isinstance(cfg, dict) else {}
    except Exception:
        result = {}

    _CONFIG_CACHE = result
    _CONFIG_MTIME = mtime
    return result


def _clear_model_list_cache() -> None:
    global _MODEL_LIST_CACHE
    with _MODEL_LIST_CACHE_LOCK:
        _MODEL_LIST_CACHE = None


def _model_section(cfg: dict[str, Any]) -> dict[str, Any]:
    model_cfg = cfg.get("model")
    if isinstance(model_cfg, dict):
        data = dict(model_cfg)
        if not data.get("default") and data.get("model"):
            data["default"] = data.get("model")
        return data
    if isinstance(model_cfg, str) and model_cfg.strip():
        return {"default": model_cfg.strip()}
    return {}


def _normalize_reasoning(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if normalized in ALLOWED_REASONING else None


def _default_reasoning(cfg: dict[str, Any]) -> str | None:
    agent_cfg = cfg.get("agent")
    raw = agent_cfg.get("reasoning_effort") if isinstance(agent_cfg, dict) else None
    return _normalize_reasoning(raw) or "medium"


def _set_defaults(request: dict[str, Any]) -> dict[str, Any]:
    global _CONFIG_CACHE
    _ensure_imports()
    from hermes_cli.config import load_config as _load_full_config, save_config

    cfg = _load_full_config()

    if not isinstance(cfg.get("model"), dict):
        cfg["model"] = {}

    if "model" in request:
        raw_model = request["model"]
        if isinstance(raw_model, str) and raw_model.strip():
            model_val = raw_model.strip()
            parsed = _parse_provider_model(model_val)
            if parsed:
                provider_hint, bare_model = parsed
                if provider_hint and not _provider_hint_is_available(provider_hint):
                    _raise_invalid_provider(provider_hint)
                cfg["model"]["default"] = bare_model
                cfg["model"]["provider"] = provider_hint
            else:
                cfg["model"]["default"] = model_val
                cfg["model"].pop("provider", None)

    if "reasoningEffort" in request:
        normalized = _normalize_reasoning(request["reasoningEffort"])
        if normalized:
            if not isinstance(cfg.get("agent"), dict):
                cfg["agent"] = {}
            cfg["agent"]["reasoning_effort"] = normalized

    save_config(cfg)
    _CONFIG_CACHE = None
    _clear_model_list_cache()

    return _defaults_from_config(cfg)


def _defaults_from_config(cfg: dict[str, Any] | None = None) -> dict[str, Any]:
    cfg = cfg if cfg is not None else _load_config()
    model_cfg = _model_section(cfg)
    display_cfg = cfg.get("display")

    return {
        "provider": _string_or_none(model_cfg.get("provider")),
        "model": _string_or_none(model_cfg.get("default")),
        "baseUrl": _string_or_none(model_cfg.get("base_url")),
        "apiMode": _string_or_none(model_cfg.get("api_mode")),
        "reasoningEffort": _default_reasoning(cfg),
        "showReasoning": bool(display_cfg.get("show_reasoning")) if isinstance(display_cfg, dict) and isinstance(display_cfg.get("show_reasoning"), bool) else True,
    }


def _string_or_none(value: Any) -> str | None:
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return None


def _task_key_for(request: dict[str, Any]) -> str:
    return (
        _string_or_none(request.get("taskId"))
        or _string_or_none(request.get("sessionId"))
        or str(request.get("id"))
    )


def _try_mark_task_active(task_key: str, request_id: str) -> bool:
    with ACTIVE_TASKS_LOCK:
        if task_key in ACTIVE_TASKS:
            return False
        ACTIVE_TASKS[task_key] = request_id
        return True


def _clear_task_active(task_key: str, request_id: str) -> None:
    with ACTIVE_TASKS_LOCK:
        if ACTIVE_TASKS.get(task_key) == request_id:
            ACTIVE_TASKS.pop(task_key, None)


def _custom_providers(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    try:
        from hermes_cli.config import get_compatible_custom_providers

        providers = get_compatible_custom_providers(cfg)
        return providers if isinstance(providers, list) else []
    except Exception:
        raw = cfg.get("custom_providers")
        return raw if isinstance(raw, list) else []


def _custom_provider_models(entry: dict[str, Any]) -> list[str]:
    models: list[str] = []
    for key in ("model", "default_model"):
        value = entry.get(key)
        if isinstance(value, str) and value.strip():
            models.append(value.strip())

    raw_models = entry.get("models")
    if isinstance(raw_models, dict):
        models.extend(str(k).strip() for k in raw_models.keys() if str(k).strip())
    elif isinstance(raw_models, list):
        for item in raw_models:
            if isinstance(item, str) and item.strip():
                models.append(item.strip())
            elif isinstance(item, dict):
                mid = item.get("id") or item.get("model") or item.get("name")
                if isinstance(mid, str) and mid.strip():
                    models.append(mid.strip())

    return _dedupe(models)


def _parse_provider_model(raw: str) -> tuple[str, str] | None:
    if raw.startswith("@") and ":" in raw:
        provider, model = raw[1:].split(":", 1)
        return provider, model
    return None


def _provider_hint_is_available(provider: str) -> bool:
    if provider.startswith("custom:"):
        return True
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider  # type: ignore

        resolve_runtime_provider(requested=provider)
        return True
    except ImportError:
        return True
    except Exception:
        return False


def _raise_invalid_provider(provider: str) -> None:
    raise WorkerError(
        f"Provider '{provider}' is not configured or runnable by this Hermes install.",
        code="invalid_provider",
        hint="Choose a configured provider, or configure this provider in Hermes first.",
    )


def _dedupe(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _model_payload_id(raw_model: Any) -> str | None:
    if isinstance(raw_model, str):
        return _string_or_none(raw_model)
    if not isinstance(raw_model, dict):
        return None
    for key in ("id", "model", "name", "slug"):
        value = _string_or_none(raw_model.get(key))
        if value:
            return value
    return None


def _model_payload_label(raw_model: Any, model_id: str) -> str:
    if not isinstance(raw_model, dict):
        return model_id
    return (
        _string_or_none(raw_model.get("label"))
        or _string_or_none(raw_model.get("display_name"))
        or _string_or_none(raw_model.get("name"))
        or model_id
    )


def _float_field(data: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = data.get(key)
        if value is None:
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            continue
        if math.isfinite(number):
            return number
    return None


def _model_pricing_unit(raw_model: dict[str, Any], model_id: str) -> str:
    pricing = raw_model.get("pricing")
    pricing_data = pricing if isinstance(pricing, dict) else raw_model
    explicit_unit = _string_or_none(pricing_data.get("unit")) or _string_or_none(pricing_data.get("billing_unit"))
    if explicit_unit:
        normalized = explicit_unit.lower().replace("-", "_").replace(" ", "_")
        if "token" in normalized:
            return "million_tokens"
        if "image" in normalized:
            return "image"
        if "video" in normalized:
            return "video"
        if "audio" in normalized or "minute" in normalized:
            return "audio_minute"
        if "request" in normalized:
            return "request"

    pricing_keys = " ".join(str(key).lower() for key in pricing_data.keys())
    if "video" in pricing_keys:
        return "video"
    if "image" in pricing_keys:
        return "image"
    if "audio" in pricing_keys or "minute" in pricing_keys:
        return "audio_minute"
    if (
        "token" in pricing_keys
        or "prompt" in pricing_keys
        or "completion" in pricing_keys
        or "input_price" in pricing_keys
        or "output_price" in pricing_keys
        or "input_cost" in pricing_keys
        or "output_cost" in pricing_keys
    ):
        return "million_tokens"

    descriptors: list[str] = [model_id]
    for key in ("type", "modality", "category", "mode"):
        value = raw_model.get(key)
        if isinstance(value, str):
            descriptors.append(value)
    for key in ("modalities", "capabilities", "features", "tags"):
        value = raw_model.get(key)
        if isinstance(value, list):
            descriptors.extend(str(item) for item in value)

    descriptor = " ".join(descriptors).lower()
    if "video" in descriptor:
        return "video"
    if "image" in descriptor or "vision_generation" in descriptor:
        return "image"
    if "audio" in descriptor or "speech" in descriptor or "transcription" in descriptor:
        return "audio_minute"
    if "text" in descriptor or "chat" in descriptor or "language" in descriptor or "llm" in descriptor:
        return "million_tokens"
    return "unknown"


def _model_pricing(raw_model: Any, model_id: str) -> dict[str, Any] | None:
    if not isinstance(raw_model, dict):
        return None

    pricing = raw_model.get("pricing")
    pricing_data = pricing if isinstance(pricing, dict) else raw_model
    unit = _model_pricing_unit(raw_model, model_id)
    result: dict[str, Any] = {"unit": unit}

    input_usd = _float_field(
        pricing_data,
        "inputUsd",
        "input_usd",
        "input_price",
        "prompt_price",
        "input_cost",
        "prompt_cost",
        "input_price_per_million_tokens",
        "prompt_price_per_million_tokens",
        "price_per_image",
        "image_price",
        "price_per_video",
        "video_price",
    )
    output_usd = _float_field(
        pricing_data,
        "outputUsd",
        "output_usd",
        "output_price",
        "completion_price",
        "output_cost",
        "completion_cost",
        "output_price_per_million_tokens",
        "completion_price_per_million_tokens",
    )
    cached_input_usd = _float_field(
        pricing_data,
        "cachedInputUsd",
        "cached_input_usd",
        "cached_input_price",
        "cache_read_price",
        "cached_prompt_price",
    )
    display = _string_or_none(pricing_data.get("display")) or _string_or_none(pricing_data.get("price_display"))

    if input_usd is not None:
        result["inputUsd"] = input_usd
    if output_usd is not None:
        result["outputUsd"] = output_usd
    if cached_input_usd is not None:
        result["cachedInputUsd"] = cached_input_usd
    if display:
        result["display"] = display

    return result if len(result) > 1 or unit != "unknown" else None


def _add_model(
    groups: dict[str, list[dict[str, Any]]],
    provider: str,
    model_id: str,
    source: str,
    default_model: str | None,
    label: str | None = None,
    pricing: dict[str, Any] | None = None,
) -> None:
    if not model_id:
        return
    bucket = groups.setdefault(provider or "configured", [])
    if any(item["id"] == model_id for item in bucket):
        return
    option = {
        "id": model_id,
        "label": label or model_id,
        "source": source,
        "isCurrentDefault": bool(default_model and model_id == default_model),
    }
    if pricing:
        option["pricing"] = pricing
    bucket.append(option)


def _provider_model_ids_with_timeout(provider: str, timeout: float = 4.0) -> list[str]:
    try:
        future = _MODEL_EXECUTOR.submit(_provider_model_ids, provider)
        return future.result(timeout=timeout)
    except TimeoutError:
        return []
    except Exception:
        return []


def _provider_model_ids(provider: str) -> list[str]:
    from hermes_cli.models import provider_model_ids

    models = provider_model_ids(provider)
    return [str(model).strip() for model in models or [] if str(model).strip()]


def _groups_have_model(groups: dict[str, list[dict[str, Any]]], model_id: str) -> bool:
    return any(
        item.get("id") == model_id
        for models in groups.values()
        for item in models
    )


def _model_option_id(provider: str | None, model_id: str, active_provider: str | None) -> str:
    if not provider or provider == active_provider:
        return model_id
    if provider.startswith("custom:"):
        return model_id
    return f"@{provider}:{model_id}"


def _list_authenticated_model_groups(
    cfg: dict[str, Any],
    defaults: dict[str, Any],
) -> dict[str, list[dict[str, Any]]] | None:
    try:
        from hermes_cli.model_switch import list_authenticated_providers
    except Exception:
        return None

    providers_cfg = cfg.get("providers")
    user_providers = providers_cfg if isinstance(providers_cfg, dict) else {}
    custom_providers = _custom_providers(cfg)
    active_provider = defaults["provider"]
    default_model = defaults["model"]
    groups: dict[str, list[dict[str, Any]]] = {}

    try:
        providers = list_authenticated_providers(
            current_provider=active_provider or "",
            current_base_url=defaults.get("baseUrl") or "",
            current_model=default_model or "",
            user_providers=user_providers,
            custom_providers=custom_providers,
            max_models=500,
        )
    except Exception:
        return None

    for provider_info in providers:
        if not isinstance(provider_info, dict):
            continue
        slug = _string_or_none(provider_info.get("slug"))
        group_name = _string_or_none(provider_info.get("name")) or slug or "configured"
        is_user_defined = bool(provider_info.get("is_user_defined"))
        if not is_user_defined and slug and not _provider_hint_is_available(slug):
            continue
        source = "custom" if is_user_defined else "catalog"
        models = provider_info.get("models")
        if not isinstance(models, list):
            continue
        for raw_model in models:
            model_id = _model_payload_id(raw_model)
            if not model_id:
                continue
            option_id = model_id if is_user_defined else _model_option_id(slug, model_id, active_provider)
            _add_model(
                groups,
                group_name,
                option_id,
                source,
                default_model,
                label=_model_payload_label(raw_model, model_id),
                pricing=_model_pricing(raw_model, model_id),
            )

    return groups


def _list_models() -> dict[str, Any]:
    global _MODEL_LIST_CACHE

    cfg = _load_config()
    config_mtime = _CONFIG_MTIME
    now = time.monotonic()
    with _MODEL_LIST_CACHE_LOCK:
        cached = _MODEL_LIST_CACHE
        if cached is not None and cached.config_mtime == config_mtime and now < cached.expires_at:
            return cached.data

    defaults = _defaults_from_config(cfg)
    default_model = defaults["model"]
    active_provider = defaults["provider"]
    authenticated_groups = _list_authenticated_model_groups(cfg, defaults)
    groups = authenticated_groups or {}

    if default_model and not _groups_have_model(groups, default_model):
        _add_model(groups, active_provider or "current", default_model, "current", default_model)

    if active_provider and authenticated_groups is None:
        for model_id in _provider_model_ids_with_timeout(active_provider):
            _add_model(groups, active_provider, model_id, "catalog", default_model)

    for entry in _custom_providers(cfg):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "custom").strip() or "custom"
        provider = f"custom:{name.lower().replace(' ', '-')}"
        for model_id in _custom_provider_models(entry):
            _add_model(groups, provider, model_id, "custom", default_model)

    aliases = cfg.get("model_aliases")
    if isinstance(aliases, dict):
        for alias, target in aliases.items():
            if isinstance(alias, str) and alias.strip():
                label = f"{alias.strip()} -> {target}" if target else alias.strip()
                bucket = groups.setdefault("aliases", [])
                if not any(item["id"] == alias.strip() for item in bucket):
                    bucket.append({
                        "id": alias.strip(),
                        "label": label,
                        "source": "alias",
                        "isCurrentDefault": bool(default_model and alias.strip() == default_model),
                    })

    result = {
        "defaultModel": default_model,
        "activeProvider": active_provider,
        "groups": [{"provider": provider, "models": models} for provider, models in groups.items()],
    }

    with _MODEL_LIST_CACHE_LOCK:
        _MODEL_LIST_CACHE = _ModelListCache(
            data=result,
            config_mtime=config_mtime,
            expires_at=time.monotonic() + _MODEL_LIST_CACHE_TTL_SECONDS,
        )

    return result


def _resolve_model_provider(requested_model: str | None, cfg: dict[str, Any] | None = None) -> tuple[str, str | None, str | None]:
    cfg = cfg if cfg is not None else _load_config()
    model_cfg = _model_section(cfg)
    config_provider = _string_or_none(model_cfg.get("provider"))
    config_base_url = _string_or_none(model_cfg.get("base_url"))
    default_model = _string_or_none(model_cfg.get("default"))
    model_id = (requested_model or default_model or "").strip()

    if not model_id:
        return model_id, config_provider, config_base_url

    for entry in _custom_providers(cfg):
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name") or "").strip()
        if not name:
            continue
        if model_id in _custom_provider_models(entry):
            return model_id, f"custom:{name.lower().replace(' ', '-')}", _string_or_none(entry.get("base_url"))

    parsed = _parse_provider_model(model_id)
    if parsed:
        provider_hint, bare_model = parsed
        return bare_model, provider_hint or config_provider, None

    if "/" in model_id:
        prefix, bare = model_id.split("/", 1)
        prefix_normalized = prefix.lower()
        if config_provider == "openrouter":
            return model_id, "openrouter", config_base_url
        if config_provider and prefix_normalized == config_provider:
            return bare, config_provider, config_base_url
        if config_provider in {"nous", "opencode-zen", "opencode-go"}:
            return model_id, config_provider, config_base_url
        if config_base_url:
            if prefix_normalized in KNOWN_PROVIDER_PREFIXES:
                return bare, config_provider, config_base_url
            return model_id, config_provider, config_base_url
        if prefix_normalized in KNOWN_PROVIDER_PREFIXES and prefix_normalized != config_provider:
            return model_id, "openrouter", None

    return model_id, config_provider, config_base_url


def _resolve_toolsets(cfg: dict[str, Any]) -> list[str] | None:
    try:
        from hermes_cli.tools_config import _get_platform_tools

        toolsets = _get_platform_tools(cfg, "cli")
        return list(toolsets) if toolsets else None
    except Exception:
        platform_toolsets = cfg.get("platform_toolsets")
        if isinstance(platform_toolsets, dict) and isinstance(platform_toolsets.get("cli"), list):
            return list(platform_toolsets["cli"])
    return None


def _fallback_model(cfg: dict[str, Any]) -> dict[str, Any] | None:
    raw = cfg.get("fallback_model")
    if not isinstance(raw, dict):
        return None
    model = _string_or_none(raw.get("model"))
    if not model:
        return None
    return {
        "model": model,
        "provider": _string_or_none(raw.get("provider")),
        "base_url": _string_or_none(raw.get("base_url")),
    }


def _parse_reasoning(effort: str | None) -> dict[str, Any] | None:
    if not effort:
        return None
    try:
        from hermes_constants import parse_reasoning_effort

        return parse_reasoning_effort(effort)
    except Exception:
        if effort == "none":
            return {"enabled": False}
        if effort in ALLOWED_REASONING:
            return {"enabled": True, "effort": effort}
    return None


AGENT_HISTORY_KEYS = {
    "role",
    "content",
    "tool_calls",
    "tool_call_id",
    "tool_name",
    "finish_reason",
    "reasoning",
    "reasoning_content",
    "reasoning_details",
    "codex_reasoning_items",
    "codex_message_items",
}


def _sanitize_agent_history(history: Any) -> list[dict[str, Any]]:
    if not isinstance(history, list):
        return []
    safe: list[dict[str, Any]] = []
    for item in history:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        if role not in {"user", "assistant", "system", "tool"}:
            continue

        safe_item = {
            key: _json_safe(value)
            for key, value in item.items()
            if key in AGENT_HISTORY_KEYS and value is not None
        }
        if not safe_item.get("content") and not safe_item.get("tool_calls") and not safe_item.get("tool_call_id"):
            continue
        safe_item["role"] = role
        safe.append(safe_item)
    return safe


def _json_safe(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {str(key): _json_safe(val) for key, val in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    return str(value)


def _session_db_or_error() -> Any:
    _ensure_imports()
    if _SessionDB is None:
        raise WorkerError(
            "Hermes session database is unavailable.",
            code="session_db_unavailable",
        )
    return _SessionDB()


def _resolve_live_session_id(session_db: Any, session_id: str) -> str:
    resolve = getattr(session_db, "resolve_resume_session_id", None)
    if callable(resolve):
        try:
            return resolve(session_id) or session_id
        except Exception:
            return session_id
    return session_id


def _load_agent_history(session_db: Any, session_id: str) -> list[dict[str, Any]]:
    if not session_id:
        return []
    try:
        get_session = getattr(session_db, "get_session", None)
        if callable(get_session) and not get_session(session_id):
            return []
        history = session_db.get_messages_as_conversation(session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session history: {exc}", code="session_load_error") from exc
    return _sanitize_agent_history(history)


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if content is None:
        return ""
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                if item:
                    parts.append(item)
                continue
            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text:
                    parts.append(text)
                    continue
                item_type = _string_or_none(item.get("type"))
                if item_type:
                    parts.append(f"[{item_type}]")
        return "\n".join(parts) if parts else "[non-text content]"
    if isinstance(content, dict):
        text = content.get("text") or content.get("content")
        if isinstance(text, str):
            return text
        return "[non-text content]"
    return str(content)


def _strip_bees_user_scaffold(content: str) -> str:
    stripped = content.lstrip()
    if stripped.startswith("[TASK AGENT]"):
        marker = "[TASK DESCRIPTION]"
        marker_index = stripped.find(marker)
        if marker_index >= 0:
            return stripped[marker_index + len(marker):].lstrip("\r\n ")

    if stripped.startswith("<task_agent>"):
        marker = "</task_agent>"
        marker_index = stripped.find(marker)
        if marker_index >= 0:
            remainder = stripped[marker_index + len(marker):].lstrip()
            if remainder.startswith("<task_description>"):
                end_marker = "</task_description>"
                end_index = remainder.find(end_marker)
                if end_index >= 0:
                    return remainder[len("<task_description>"):end_index].strip()
            return remainder

    return content


def _timestamp_to_ms(timestamp: Any) -> int:
    try:
        value = float(timestamp)
    except (TypeError, ValueError):
        return int(time.time() * 1000)
    if value < 10_000_000_000:
        value *= 1000
    return int(value)


def _thinking_to_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value or None
    try:
        return json.dumps(value, ensure_ascii=False)
    except Exception:
        return str(value)


def _project_session_messages(session_id: Any, task_id: Any = None) -> dict[str, Any]:
    session_id = _string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    session_db = _session_db_or_error()
    live_session_id = _resolve_live_session_id(session_db, session_id)
    try:
        rows = session_db.get_messages(live_session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session messages: {exc}", code="session_load_error") from exc

    projected: list[dict[str, Any]] = []
    projected_task_id = _string_or_none(task_id) or session_id

    for row in rows:
        if not isinstance(row, dict):
            row = dict(row)
        role = row.get("role")
        if role not in {"user", "assistant"}:
            continue

        content = _content_to_text(row.get("content"))
        if role == "user":
            content = _strip_bees_user_scaffold(content)
        if role == "assistant" and not content.strip() and row.get("tool_calls"):
            continue
        if not content.strip():
            continue

        message = {
            "id": f"hermes:{live_session_id}:{row.get('id')}",
            "task_id": projected_task_id,
            "role": role,
            "content": content,
            "created_at": _timestamp_to_ms(row.get("timestamp")),
        }
        if role == "assistant":
            thinking = (
                _thinking_to_text(row.get("reasoning_content"))
                or _thinking_to_text(row.get("reasoning"))
                or _thinking_to_text(row.get("reasoning_details"))
                or _thinking_to_text(row.get("codex_reasoning_items"))
            )
            if thinking:
                message["thinking"] = thinking
        projected.append(message)

    return {"messages": projected}


def _int_field(row: dict[str, Any], key: str) -> int:
    try:
        return int(row.get(key) or 0)
    except Exception:
        return 0


def _float_or_none(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except Exception:
        return None


def _project_session_metadata(session_id: Any) -> dict[str, Any]:
    session_id = _string_or_none(session_id)
    if not session_id:
        raise WorkerError("Session ID is required.", code="bad_request")

    session_db = _session_db_or_error()
    live_session_id = _resolve_live_session_id(session_db, session_id)
    try:
        row = session_db.get_session(live_session_id)
    except Exception as exc:
        raise WorkerError(f"Could not load Hermes session metadata: {exc}", code="session_load_error") from exc

    if not row:
        return {"session": None}

    return {
        "session": {
            "id": str(row.get("id") or live_session_id),
            "input_tokens": _int_field(row, "input_tokens"),
            "output_tokens": _int_field(row, "output_tokens"),
            "cache_read_tokens": _int_field(row, "cache_read_tokens"),
            "cache_write_tokens": _int_field(row, "cache_write_tokens"),
            "reasoning_tokens": _int_field(row, "reasoning_tokens"),
            "estimated_cost_usd": _float_or_none(row.get("estimated_cost_usd")),
            "cost_status": _string_or_none(row.get("cost_status")) or "unknown",
            "model": _string_or_none(row.get("model")),
        }
    }


def _normalize_cron_job(job: dict[str, Any] | None) -> dict[str, Any] | None:
    if not isinstance(job, dict):
        return None

    job_id = _string_or_none(job.get("id")) or ""
    raw_schedule = job.get("schedule")
    raw_origin = job.get("origin")
    raw_skills = job.get("skills")
    if raw_skills is None and job.get("skill"):
        raw_skills = [job.get("skill")]

    return {
        "id": job_id,
        "name": _string_or_none(job.get("name")) or job_id,
        "prompt": _string_or_none(job.get("prompt")),
        "schedule": _json_safe(raw_schedule) if isinstance(raw_schedule, dict) else None,
        "scheduleDisplay": _string_or_none(job.get("schedule_display")),
        "enabled": bool(job.get("enabled", True)),
        "state": _string_or_none(job.get("state")),
        "nextRunAt": _string_or_none(job.get("next_run_at")),
        "lastRunAt": _string_or_none(job.get("last_run_at")),
        "lastStatus": _string_or_none(job.get("last_status")),
        "lastError": _string_or_none(job.get("last_error")),
        "lastDeliveryError": _string_or_none(job.get("last_delivery_error")),
        "model": _string_or_none(job.get("model")),
        "provider": _string_or_none(job.get("provider")),
        "baseUrl": _string_or_none(job.get("base_url")),
        "deliver": _string_or_none(job.get("deliver")),
        "origin": _json_safe(raw_origin) if isinstance(raw_origin, dict) else None,
        "skills": [str(item) for item in raw_skills] if isinstance(raw_skills, list) else [],
        "createdAt": _string_or_none(job.get("created_at")),
    }


def _validate_cron_job_id(job_id: Any) -> str:
    value = _string_or_none(job_id)
    if not value:
        raise WorkerError("Cron job ID is required.", code="bad_request")
    if "/" in value or "\\" in value or ".." in value:
        raise WorkerError("Invalid cron job ID.", code="bad_request")
    return value


def _list_cron_jobs(include_disabled: bool = False) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import list_jobs

    jobs = [_normalize_cron_job(job) for job in list_jobs(include_disabled=include_disabled)]
    return {"jobs": [job for job in jobs if job is not None]}


def _get_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import get_job

    job = _normalize_cron_job(get_job(_validate_cron_job_id(job_id)))
    return {"job": job}


def _pause_cron_job(job_id: Any, reason: Any = None) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import pause_job

    raw_reason = _string_or_none(reason)
    job = _normalize_cron_job(pause_job(_validate_cron_job_id(job_id), reason=raw_reason))
    return {"job": job}


def _resume_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import resume_job

    job = _normalize_cron_job(resume_job(_validate_cron_job_id(job_id)))
    return {"job": job}


def _trigger_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import trigger_job

    job = _normalize_cron_job(trigger_job(_validate_cron_job_id(job_id)))
    return {"job": job}


def _remove_cron_job(job_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import remove_job

    removed = bool(remove_job(_validate_cron_job_id(job_id)))
    return {"ok": removed}


def _run_preview(content: str, max_chars: int = 420) -> str:
    lines = [line.strip() for line in content.splitlines() if line.strip()]
    preview = "\n".join(lines[:6])
    if len(preview) > max_chars:
        preview = preview[: max_chars - 3].rstrip() + "..."
    return preview


def _run_timestamp_from_stem(stem: str) -> str | None:
    try:
        return datetime.strptime(stem, "%Y-%m-%d_%H-%M-%S").isoformat()
    except ValueError:
        return None


def _cron_run_status(content: str) -> str:
    first_line = next((line.strip() for line in content.splitlines() if line.strip()), "")
    if first_line.startswith("# Cron Job:") and "(FAILED)" in first_line:
        return "error"
    if first_line.startswith("# Cron Job:"):
        return "ok"
    return "unknown"


def _read_run_head(path: Path, max_bytes: int = 2048) -> str:
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            return f.read(max_bytes)
    except OSError:
        return ""


def _list_cron_runs(job_id: Any, limit: Any = 20) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import OUTPUT_DIR

    cron_job_id = _validate_cron_job_id(job_id)
    try:
        parsed_limit = int(limit)
    except (TypeError, ValueError):
        parsed_limit = 20
    parsed_limit = max(1, min(parsed_limit, 100))

    output_dir = Path(OUTPUT_DIR) / cron_job_id
    if not output_dir.exists():
        return {"runs": []}

    entries = []
    for path in output_dir.glob("*.md"):
        try:
            st = path.stat()
        except OSError:
            continue
        if not st.st_mode & 0o100000:
            continue
        entries.append((st.st_mtime, path))
    entries.sort(key=lambda entry: (entry[0], entry[1].name), reverse=True)
    files = [path for _, path in entries]

    runs: list[dict[str, Any]] = []
    for path in files[:parsed_limit]:
        head = _read_run_head(path)
        runs.append({
            "id": path.stem,
            "jobId": cron_job_id,
            "ranAt": _run_timestamp_from_stem(path.stem),
            "path": str(path),
            "status": _cron_run_status(head),
            "preview": _run_preview(head),
        })

    return {"runs": runs}


def _get_cron_run_content(job_id: Any, run_id: Any) -> dict[str, Any]:
    _ensure_imports()
    from cron.jobs import OUTPUT_DIR

    cron_job_id = _validate_cron_job_id(job_id)
    raw_run_id = _string_or_none(run_id)
    if not raw_run_id or "/" in raw_run_id or "\\" in raw_run_id or ".." in raw_run_id:
        raise WorkerError("Run ID is required.", code="bad_request")

    path = Path(OUTPUT_DIR) / cron_job_id / f"{raw_run_id}.md"
    if not path.is_file():
        raise WorkerError("Cron run output not found.", code="not_found")

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = path.read_text(encoding="utf-8", errors="replace")

    return {"content": content}


def _tick_cron() -> int:
    _ensure_imports()
    from cron.scheduler import tick

    return int(tick(verbose=False) or 0)


def _cron_ticker_loop() -> None:
    while True:
        try:
            executed = _tick_cron()
            if executed:
                print(f"[hermes-worker] cron tick executed {executed} job(s)", file=sys.stderr, flush=True)
        except Exception as exc:
            print(f"[hermes-worker] cron tick failed: {exc}", file=sys.stderr, flush=True)
        time.sleep(60)


def _start_cron_ticker() -> None:
    global _CRON_TICKER_STARTED
    with _CRON_TICKER_LOCK:
        if _CRON_TICKER_STARTED:
            return
        thread = threading.Thread(target=_cron_ticker_loop, name="hermes-cron-ticker", daemon=True)
        thread.start()
        _CRON_TICKER_STARTED = True


def _create_agent(
    *,
    session_id: str,
    requested_model: str | None,
    reasoning_effort: str | None,
    callbacks: dict[str, Any] | None = None,
) -> Any:
    _ensure_imports()
    cfg = _load_config()
    defaults = _defaults_from_config(cfg)
    resolved_reasoning_effort = reasoning_effort or defaults.get("reasoningEffort")
    resolved_model, resolved_provider, resolved_base_url = _resolve_model_provider(requested_model, cfg)

    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider  # type: ignore

        runtime = resolve_runtime_provider(
            requested=resolved_provider,
            explicit_base_url=resolved_base_url,
            target_model=resolved_model,
        )
    except Exception as exc:
        err = _error_payload(exc)
        raise WorkerError(str(exc), code=err.get("code", "worker_error"), hint=err.get("hint")) from exc

    if not resolved_provider:
        resolved_provider = _string_or_none(runtime.get("provider"))
    if not resolved_base_url:
        resolved_base_url = _string_or_none(runtime.get("base_url"))

    def clarify_callback(question: Any, choices: Any = None) -> str:
        return (
            "The user is not available for an interactive clarification right now. "
            "Make a reasonable assumption, proceed, and call out the assumption in the response if it matters."
        )

    session_db = None
    if _SessionDB is not None:
        try:
            session_db = _SessionDB()
        except Exception:
            session_db = None

    agent_params = _AIAgent_PARAMS
    agent_kwargs: dict[str, Any] = {
        "model": resolved_model,
        "provider": resolved_provider,
        "base_url": resolved_base_url,
        "api_key": runtime.get("api_key"),
        "quiet_mode": True,
        "verbose_logging": False,
        "platform": "bees",
        "session_id": session_id,
        "session_db": session_db,
        "enabled_toolsets": _resolve_toolsets(cfg),
        "fallback_model": _fallback_model(cfg),
        "clarify_callback": clarify_callback,
    }
    if callbacks:
        agent_kwargs.update(callbacks)

    reasoning_config = _parse_reasoning(resolved_reasoning_effort)
    if "reasoning_config" in agent_params and reasoning_config is not None:
        agent_kwargs["reasoning_config"] = reasoning_config
    if "api_mode" in agent_params:
        agent_kwargs["api_mode"] = runtime.get("api_mode")
    if "acp_command" in agent_params:
        agent_kwargs["acp_command"] = runtime.get("command")
    elif "command" in agent_params:
        agent_kwargs["command"] = runtime.get("command")
    if "acp_args" in agent_params:
        agent_kwargs["acp_args"] = list(runtime.get("args") or [])
    elif "args" in agent_params:
        agent_kwargs["args"] = list(runtime.get("args") or [])
    if "credential_pool" in agent_params:
        agent_kwargs["credential_pool"] = runtime.get("credential_pool")
    if "gateway_session_key" in agent_params:
        agent_kwargs["gateway_session_key"] = session_id

    filtered_kwargs = {
        key: value
        for key, value in agent_kwargs.items()
        if key in agent_params and value is not None
    }

    return _AIAgent(**filtered_kwargs)


def _sync_session_identity(agent: Any, session_id: str) -> None:
    """Refresh persisted Hermes session metadata when Bees switches models."""
    session_db = getattr(agent, "_session_db", None)
    model = _string_or_none(getattr(agent, "model", None))
    if not session_db or not session_id or not model:
        return

    try:
        session_row = session_db.get_session(session_id)
    except Exception:
        return
    if not session_row:
        return

    model_config = getattr(agent, "_session_init_model_config", None)
    stored_model = _string_or_none(session_row.get("model"))
    if stored_model == model:
        return

    model_config_json = None
    if model_config:
        try:
            model_config_json = json.dumps(model_config)
        except Exception:
            model_config_json = None

    execute_write = getattr(session_db, "_execute_write", None)
    if callable(execute_write):
        def _do(conn: Any) -> None:
            if model_config_json is None:
                conn.execute(
                    "UPDATE sessions SET model = ?, system_prompt = NULL WHERE id = ?",
                    (model, session_id),
                )
            else:
                conn.execute(
                    "UPDATE sessions SET model = ?, model_config = ?, system_prompt = NULL WHERE id = ?",
                    (model, model_config_json, session_id),
                )

        try:
            execute_write(_do)
        except Exception:
            return
    else:
        try:
            session_db.update_system_prompt(session_id, None)
        except Exception:
            return

    try:
        setattr(agent, "_cached_system_prompt", None)
    except Exception:
        pass


def _warm_agent() -> None:
    _create_agent(
        session_id="bees-healthcheck",
        requested_model=None,
        reasoning_effort=None,
    )


def _run_chat(request_id: str, request: dict[str, Any]) -> None:
    settings = request.get("settings") if isinstance(request.get("settings"), dict) else {}
    requested_model = _string_or_none(settings.get("model"))
    requested_effort = _normalize_reasoning(settings.get("reasoningEffort"))

    session_id = _string_or_none(request.get("sessionId")) or request_id
    message = request.get("message")
    if not isinstance(message, str) or not message.strip():
        raise WorkerError("Chat request message is required.", code="bad_request")

    session_db = _session_db_or_error()
    session_id = _resolve_live_session_id(session_db, session_id)
    history = _load_agent_history(session_db, session_id)
    system_message = request.get("systemMessage")
    if not isinstance(system_message, str):
        system_message = None

    state = {"text": "", "thinking": ""}

    def on_text_delta(text: Any) -> None:
        if text is None:
            return
        chunk = str(text)
        state["text"] += chunk
        _send({"id": request_id, "type": "text_delta", "content": chunk})

    def on_reasoning_delta(text: Any) -> None:
        if text is None:
            return
        chunk = str(text)
        if not chunk:
            return
        state["thinking"] += chunk
        _send({"id": request_id, "type": "thinking_delta", "content": chunk})

    def on_tool_progress(*args: Any, **kwargs: Any) -> None:
        event_type = None
        name = None
        preview = None
        tool_args = None

        if len(args) >= 4:
            event_type, name, preview, tool_args = args[:4]
        elif len(args) == 3:
            name, preview, tool_args = args
            event_type = "tool.started"
        elif len(args) == 2:
            event_type, name = args
        elif len(args) == 1:
            name = args[0]
            event_type = "tool.started"

        tool_name = str(name or "tool")
        if event_type in {None, "tool.started"}:
            _send({
                "id": request_id,
                "type": "tool_progress",
                "tool": tool_name,
                "status": "running",
                "label": str(preview) if preview else None,
                "details": _json_safe(tool_args),
            })
            return

        if event_type == "tool.completed":
            _send({
                "id": request_id,
                "type": "tool_progress",
                "tool": tool_name,
                "status": "error" if kwargs.get("is_error") else "completed",
                "duration": kwargs.get("duration"),
                "label": str(preview) if preview else None,
                "details": _json_safe(tool_args),
            })

    agent = _create_agent(
        session_id=session_id,
        requested_model=requested_model,
        reasoning_effort=requested_effort,
        callbacks={
            "stream_delta_callback": on_text_delta,
            "reasoning_callback": on_reasoning_delta,
            "tool_progress_callback": on_tool_progress,
        },
    )
    _sync_session_identity(agent, session_id)
    task_id = _string_or_none(request.get("taskId")) or session_id
    task_title = _string_or_none(request.get("taskTitle")) or task_id
    session_tokens = None
    clear_session_vars = None
    try:
        from gateway.session_context import set_session_vars, clear_session_vars as _clear_session_vars

        clear_session_vars = _clear_session_vars
        session_tokens = set_session_vars(
            platform="bees",
            chat_id=task_id,
            chat_name=task_title,
            session_key=session_id,
        )
    except Exception:
        session_tokens = None

    try:
        result = agent.run_conversation(
            user_message=message,
            system_message=system_message,
            conversation_history=history,
            task_id=session_id,
        )
    finally:
        if session_tokens is not None and clear_session_vars is not None:
            try:
                clear_session_vars(session_tokens)
            except Exception:
                pass

    final_text = str(result.get("final_response") or "")
    if final_text and not state["text"]:
        _send({"id": request_id, "type": "text_delta", "content": final_text})
    if result.get("last_reasoning") and not state["thinking"]:
        _send({"id": request_id, "type": "thinking_delta", "content": str(result["last_reasoning"])})

    context_engine = getattr(agent, "context_compressor", None)
    context_used = int(result.get("last_prompt_tokens") or 0)
    context_window = int(getattr(context_engine, "context_length", 0) or 0)
    context = None
    if context_used > 0 and context_window > 0:
        context = {
            "used_tokens": context_used,
            "window_tokens": context_window,
        }
    _send({"id": request_id, "type": "done", "sessionId": getattr(agent, "session_id", None) or session_id, "context": context})


def _run_chat_thread(request_id: str, request: dict[str, Any], task_key: str) -> None:
    done_sent = False
    acquired = False
    try:
        AGENT_SEMAPHORE.acquire()
        acquired = True
        _run_chat(request_id, request)
        done_sent = True
    except Exception as exc:
        _send_error(request_id, exc)
    finally:
        if not done_sent:
            _send({
                "id": request_id,
                "type": "done",
                "sessionId": _string_or_none(request.get("sessionId")) or request_id,
            })
        if acquired:
            AGENT_SEMAPHORE.release()
        _clear_task_active(task_key, request_id)


def _judge_completion(request: dict[str, Any]) -> dict[str, Any]:
    """Evaluate whether the agent's response indicates task completion."""
    task_title = _string_or_none(request.get("taskTitle")) or ""
    task_description = _string_or_none(request.get("taskDescription")) or ""
    response_text = _string_or_none(request.get("responseText")) or ""

    if not response_text.strip():
        return {"done": False, "reason": "empty response"}

    max_chars = 4000
    if len(response_text) > max_chars:
        response_text = response_text[:max_chars] + "..."

    task_context = task_title
    if task_description:
        task_context += f"\n{task_description}"

    judge_system = (
        "You are a task completion judge. "
        "Respond ONLY with a JSON object, nothing else. "
        "Do not use any tools."
    )

    judge_prompt = (
        f"Task:\n{task_context}\n\n"
        f"Agent's most recent response:\n{response_text}\n\n"
        'Has the agent completed the task? Respond with: {"done": true/false, "reason": "one sentence"}\n'
        "- done=true ONLY when the response clearly delivers the final result or confirms completion\n"
        "- done=false for: questions, partial progress, clarification requests, errors, or ongoing work"
    )

    session_id = f"bees-judge-{uuid.uuid4().hex[:8]}"

    agent = _create_agent(
        session_id=session_id,
        requested_model=None,
        reasoning_effort="none",
    )

    result = agent.run_conversation(
        user_message=judge_prompt,
        system_message=judge_system,
        conversation_history=[],
    )

    text = str(result.get("final_response") or "")
    json_match = re.search(r"\{[^{}]*\}", text)
    if json_match:
        try:
            parsed = json.loads(json_match.group())
            return {
                "done": bool(parsed.get("done", False)),
                "reason": str(parsed.get("reason", "")),
            }
        except (json.JSONDecodeError, ValueError):
            pass

    return {"done": False, "reason": "unparseable response"}


def _normalize_activity_intent_decision(parsed: dict[str, Any], transcript: str, fallback_text: str | None = None) -> dict[str, Any]:
    fallback = (fallback_text or transcript).strip()
    has_enough_context = bool(parsed.get("hasEnoughContext", False))
    requested_action = str(parsed.get("action") or "save_context")
    action = "create_task" if requested_action == "create_task" and has_enough_context else "save_context"
    title = str(parsed.get("title") or "").strip()
    task_description = str(parsed.get("taskDescription") or "").strip()
    reason = str(parsed.get("reason") or "").strip()
    screen_context_required = bool(parsed.get("screenContextRequired", False))

    if not title:
        title = fallback[:80] if action == "create_task" else "Saved voice context"
    if not task_description:
        task_description = fallback
    if not reason:
        reason = (
            "Transcript contains an actionable task."
            if action == "create_task"
            else "Transcript does not contain enough task context."
        )

    return {
        "action": action,
        "title": title[:80],
        "taskDescription": task_description,
        "hasEnoughContext": action == "create_task",
        "screenContextRequired": screen_context_required,
        "reason": reason,
    }


def _judge_activity_intent(request: dict[str, Any]) -> dict[str, Any]:
    """Classify wake-word activity from spoken input and captured context."""
    transcript = _string_or_none(request.get("transcript")) or ""
    transcript = transcript.strip()
    captured_text = _string_or_none(request.get("capturedText")) or ""
    captured_text = captured_text.strip()
    if (not transcript or transcript == "[input pending]") and not captured_text:
        return {
            "action": "save_context",
            "title": "Saved voice context",
            "taskDescription": "",
            "hasEnoughContext": False,
            "screenContextRequired": False,
            "reason": "Spoken input and captured context are empty or still pending.",
        }

    system_message = _string_or_none(request.get("systemMessage")) or (
        "You are a wake-word activity intent classifier. Respond ONLY with JSON. "
        "Decide from the spoken input and captured selected text/window/image metadata. "
        "Do not invent visual details from screenshots you cannot inspect."
    )
    prompt = _string_or_none(request.get("prompt"))
    if not prompt:
        timestamp = _string_or_none(request.get("timestamp"))
        source = _string_or_none(request.get("source"))
        active_window = request.get("activeWindow")
        images = request.get("images")
        metadata = []
        if timestamp:
            metadata.append(f"timestamp: {timestamp}")
        if source:
            metadata.append(f"source: {source}")
        metadata_text = "\n".join(metadata)
        context = []
        if captured_text:
            context.append(f"Captured selected text:\n{captured_text}")
        if isinstance(active_window, dict):
            context.append("Active window:\n" + json.dumps(active_window, ensure_ascii=False, indent=2))
        if isinstance(images, dict):
            context.append("Captured image metadata:\n" + json.dumps(images, ensure_ascii=False, indent=2))
        context_text = "\n\n".join(context)
        prompt = (
            (f"Metadata:\n{metadata_text}\n\n" if metadata_text else "")
            + f"Transcript:\n{transcript or '[none]'}\n\n"
            + (f"Captured context:\n{context_text}\n\n" if context_text else "")
            + "Classify whether this wake-word event is enough to create and start an autonomous task. "
            + 'Return {"action":"create_task"|"save_context","title":"short title",'
            + '"taskDescription":"task prompt based on spoken input and captured context","hasEnoughContext":true|false,'
            + '"screenContextRequired":true|false,"reason":"one sentence"}'
        )

    session_id = f"bees-activity-intent-{uuid.uuid4().hex[:8]}"
    requested_model = _string_or_none(request.get("model"))
    requested_reasoning = _normalize_reasoning_effort(_string_or_none(request.get("reasoningEffort"))) or "none"
    agent = _create_agent(
        session_id=session_id,
        requested_model=requested_model,
        reasoning_effort=requested_reasoning,
    )

    result = agent.run_conversation(
        user_message=prompt,
        system_message=system_message,
        conversation_history=[],
    )

    text = str(result.get("final_response") or "")
    json_match = re.search(r"\{[^{}]*\}", text)
    if json_match:
        try:
            parsed = json.loads(json_match.group())
            if isinstance(parsed, dict):
                return _normalize_activity_intent_decision(parsed, transcript, captured_text)
        except (json.JSONDecodeError, ValueError):
            pass

    return {
        "action": "save_context",
        "title": "Saved voice context",
        "taskDescription": transcript or captured_text,
        "hasEnoughContext": False,
        "screenContextRequired": False,
        "reason": "Activity intent classifier returned an unparseable response.",
    }


def _run_judge_thread(request_id: str, request: dict[str, Any]) -> None:
    acquired = False
    try:
        AGENT_SEMAPHORE.acquire()
        acquired = True
        if request.get("type") == "judge.activity_intent":
            result_data = _judge_activity_intent(request)
        else:
            result_data = _judge_completion(request)
        _result(request_id, result_data)
    except Exception as exc:
        _send_error(request_id, exc)
    finally:
        if acquired:
            AGENT_SEMAPHORE.release()


def _submit_judge_request(request_id: str, request: dict[str, Any]) -> None:
    thread = threading.Thread(
        target=_run_judge_thread,
        args=(request_id, request),
        daemon=True,
        name=f"judge-{request_id[:8]}",
    )
    thread.start()


def _submit_chat_request(request_id: str, request: dict[str, Any]) -> None:
    task_key = _task_key_for(request)
    if not _try_mark_task_active(task_key, request_id):
        _send_error(
            request_id,
            WorkerError(
                "This task is already running. Wait for the current turn to finish, then retry.",
                code="task_busy",
            ),
        )
        _send({
            "id": request_id,
            "type": "done",
            "sessionId": _string_or_none(request.get("sessionId")) or request_id,
        })
        return

    thread = threading.Thread(
        target=_run_chat_thread,
        args=(request_id, request, task_key),
        daemon=True,
        name=f"agent-{request_id[:8]}",
    )
    thread.start()


def _handle_request(request: dict[str, Any]) -> None:
    request_id = str(request.get("id") or "")
    if not request_id:
        return

    request_type = request.get("type")
    try:
        if request_type == "health":
            _ensure_imports()
            cfg = _load_config()
            _result(request_id, {
                "ok": True,
                "agentDir": str(_AGENT_DIR) if _AGENT_DIR else None,
                "python": sys.executable,
                "defaults": _defaults_from_config(cfg),
            })
        elif request_type == "settings.get":
            _result(request_id, _defaults_from_config())
        elif request_type == "settings.set":
            _result(request_id, _set_defaults(request))
        elif request_type == "models.list":
            _result(request_id, _list_models())
        elif request_type == "cron.jobs.list":
            _result(request_id, _list_cron_jobs(bool(request.get("includeDisabled"))))
        elif request_type == "cron.jobs.get":
            _result(request_id, _get_cron_job(request.get("jobId")))
        elif request_type == "cron.jobs.runs":
            _result(request_id, _list_cron_runs(request.get("jobId"), request.get("limit", 20)))
        elif request_type == "cron.jobs.run.content":
            _result(request_id, _get_cron_run_content(request.get("jobId"), request.get("runId")))
        elif request_type == "cron.jobs.pause":
            _result(request_id, _pause_cron_job(request.get("jobId"), request.get("reason")))
        elif request_type == "cron.jobs.resume":
            _result(request_id, _resume_cron_job(request.get("jobId")))
        elif request_type == "cron.jobs.run":
            _result(request_id, _trigger_cron_job(request.get("jobId")))
        elif request_type == "cron.jobs.remove":
            _result(request_id, _remove_cron_job(request.get("jobId")))
        elif request_type == "cron.tick":
            _result(request_id, {"executed": _tick_cron()})
        elif request_type == "session.messages.get":
            _result(request_id, _project_session_messages(request.get("sessionId"), request.get("taskId")))
        elif request_type == "session.get":
            _result(request_id, _project_session_metadata(request.get("sessionId")))
        elif request_type == "chat":
            _submit_chat_request(request_id, request)
        elif request_type == "judge.completion" or request_type == "judge.activity_intent":
            _submit_judge_request(request_id, request)
        else:
            raise WorkerError(f"Unknown request type: {request_type}", code="bad_request")
    except Exception as exc:
        _send_error(request_id, exc)
        if request_type == "chat":
            _send({
                "id": request_id,
                "type": "done",
                "sessionId": _string_or_none(request.get("sessionId")) or request_id,
            })


def _run_loop() -> None:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                continue
            _handle_request(request)
        except Exception as exc:
            print(f"[hermes-worker] failed to handle request: {exc}", file=sys.stderr, flush=True)
            traceback.print_exc(file=sys.stderr)


def _self_test() -> int:
    try:
        _ensure_imports()
        cfg = _load_config()
        payload = {
            "ok": True,
            "agentDir": str(_AGENT_DIR) if _AGENT_DIR else None,
            "python": sys.executable,
            "defaults": _defaults_from_config(cfg),
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": _error_payload(exc)}, ensure_ascii=False, indent=2))
        return 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    os.environ.setdefault("HERMES_QUIET", "1")
    os.environ.setdefault("HERMES_YOLO_MODE", "1")

    if args.self_test:
        return _self_test()

    sys.stdout = sys.stderr
    _start_cron_ticker()
    try:
        _run_loop()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
