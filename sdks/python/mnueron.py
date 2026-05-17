"""
mnueron — Python SDK for the mnueron memory backend.

Wraps the hosted HTTP API at ``https://www.mnueron.com``. For local SQLite
mode (no account, free forever), use the ``mnueron`` CLI or the MCP server
directly — this SDK requires a hosted-backend bearer token (``mnu_…``).

    pip install mnueron

    from mnueron import Mnueron
    with Mnueron(api_key="mnu_xxx") as client:
        client.save("User prefers concise replies", namespace="my-app")
        for r in client.search("how does the user like responses?",
                               namespace="my-app"):
            print(r.content, r.score)

Endpoint coverage (v0.3.x):
    * save / search / list / get / delete / update
    * bulk_search (v0.2.3 — multi-query in one HTTP round-trip)
    * date-range + metadata containment filters (v0.2.1 / v0.2.4)
    * namespaces
    * webhooks: list / create / get / update / delete (v0.3.1)
    * health (liveness probe — no auth)

Tokens come from https://www.mnueron.com/account-settings/tokens.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence

import httpx


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Memory:
    """A single memory row as returned by /api/memories."""
    id: str
    namespace: str
    content: str
    tags: List[str] = field(default_factory=list)
    source: str = "sdk"
    score: Optional[float] = None
    source_ref: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None
    created_at: Optional[int] = None
    updated_at: Optional[int] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "Memory":
        return cls(
            id=d["id"],
            namespace=d.get("namespace", d.get("namespace_name", "default")),
            content=d["content"],
            tags=d.get("tags") or [],
            source=d.get("source", "unknown"),
            score=d.get("score"),
            source_ref=d.get("source_ref"),
            metadata=d.get("metadata"),
            created_at=d.get("created_at"),
            updated_at=d.get("updated_at"),
        )


@dataclass
class Namespace:
    name: str
    count: int
    last_updated: int


@dataclass
class BulkSearchResult:
    """One entry in the bulk_search response: a query + its top-k hits."""
    query: str
    hits: List[Memory]


@dataclass
class WebhookEndpoint:
    """Subscription record. ``secret`` is only set on create()."""
    id: str
    url: str
    events: List[str]
    description: Optional[str] = None
    enabled: bool = True
    secret: Optional[str] = None
    consecutive_failures: int = 0
    last_success_at: Optional[int] = None
    last_failure_at: Optional[int] = None
    created_at: Optional[int] = None
    updated_at: Optional[int] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "WebhookEndpoint":
        return cls(
            id=d["id"],
            url=d["url"],
            events=list(d.get("events") or []),
            description=d.get("description"),
            enabled=bool(d.get("enabled", True)),
            secret=d.get("secret"),
            consecutive_failures=int(d.get("consecutive_failures") or 0),
            last_success_at=d.get("last_success_at"),
            last_failure_at=d.get("last_failure_at"),
            created_at=d.get("created_at"),
            updated_at=d.get("updated_at"),
        )


class MnueronError(Exception):
    """Raised when the API returns a non-2xx response."""
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"mnueron API {status}: {message}")


# ---------------------------------------------------------------------------
# Shared request helpers
# ---------------------------------------------------------------------------

DEFAULT_BASE = "https://www.mnueron.com"
_UA = "mnueron-python/0.3.1"


def _build_list_params(
    *,
    q: Optional[str],
    namespace: Optional[str],
    limit: int,
    offset: int,
    created_after: Optional[int],
    created_before: Optional[int],
    updated_after: Optional[int],
    updated_before: Optional[int],
    metadata_filter: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Shape /api/memories GET querystring."""
    import json as _json

    params: Dict[str, Any] = {"limit": limit, "offset": offset}
    if q:
        params["q"] = q
    if namespace is not None:
        params["namespace"] = namespace
    if created_after is not None:
        params["created_after"] = int(created_after)
    if created_before is not None:
        params["created_before"] = int(created_before)
    if updated_after is not None:
        params["updated_after"] = int(updated_after)
    if updated_before is not None:
        params["updated_before"] = int(updated_before)
    if metadata_filter:
        # Server expects a JSON-encoded object; httpx URL-encodes for us.
        params["metadata_filter"] = _json.dumps(metadata_filter, separators=(",", ":"))
    return params


def _check_response(r: httpx.Response) -> Any:
    if r.status_code >= 400:
        # Surface the JSON error field if the server provided one.
        msg: str
        try:
            payload = r.json()
            msg = payload.get("error") or r.text or r.reason_phrase
        except Exception:
            msg = r.text or r.reason_phrase
        raise MnueronError(r.status_code, msg)
    if r.status_code == 204 or not r.content:
        return None
    return r.json()


# ---------------------------------------------------------------------------
# Sync client
# ---------------------------------------------------------------------------

class Mnueron:
    """Synchronous client. Use ``with Mnueron(...) as client:`` for cleanup."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 10.0,
    ):
        api_key = api_key or os.getenv("MNUERON_API_KEY") or os.getenv("MNUERON_API_TOKEN")
        if not api_key:
            raise MnueronError(0, "api_key not provided; set MNUERON_API_KEY or pass api_key=")
        base = (base_url or os.getenv("MNUERON_API_URL") or DEFAULT_BASE).rstrip("/")
        self._client = httpx.Client(
            base_url=base,
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": _UA,
            },
            timeout=timeout,
        )

    def __enter__(self) -> "Mnueron":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # -- memories -----------------------------------------------------------

    def save(
        self,
        content: str,
        *,
        namespace: str = "default",
        tags: Optional[Sequence[str]] = None,
        source: str = "sdk",
        source_ref: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Memory:
        """Insert one memory. Returns the persisted row (with id, timestamps)."""
        body: Dict[str, Any] = {
            "content": content,
            "namespace": namespace,
            "tags": list(tags or []),
            "source": source,
        }
        if source_ref is not None:
            body["source_ref"] = source_ref
        if metadata is not None:
            body["metadata"] = dict(metadata)
        return Memory.from_dict(_check_response(self._client.post("/api/memories", json=body)))

    def search(
        self,
        query: str,
        *,
        namespace: Optional[str] = None,
        k: int = 10,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        updated_after: Optional[int] = None,
        updated_before: Optional[int] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
    ) -> List[Memory]:
        """BM25 search via /api/memories?q=… with optional date / metadata filters."""
        params = _build_list_params(
            q=query, namespace=namespace, limit=k, offset=0,
            created_after=created_after, created_before=created_before,
            updated_after=updated_after, updated_before=updated_before,
            metadata_filter=metadata_filter,
        )
        rows = _check_response(self._client.get("/api/memories", params=params)) or []
        return [Memory.from_dict(d) for d in rows]

    def bulk_search(
        self,
        queries: Sequence[str],
        *,
        namespace: Optional[str] = None,
        k: int = 5,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
    ) -> List[BulkSearchResult]:
        """v0.2.3 multi-query search in one HTTP round-trip. Max 25 queries."""
        body: Dict[str, Any] = {"queries": list(queries), "k": k}
        if namespace is not None:
            body["namespace"] = namespace
        if created_after is not None:
            body["created_after"] = int(created_after)
        if created_before is not None:
            body["created_before"] = int(created_before)
        if metadata_filter is not None:
            body["metadata_filter"] = dict(metadata_filter)
        payload = _check_response(self._client.post("/api/memories/search/bulk", json=body)) or {}
        results = payload.get("results") or []
        return [
            BulkSearchResult(
                query=row.get("query", ""),
                hits=[Memory.from_dict(h) for h in (row.get("hits") or [])],
            )
            for row in results
        ]

    def list(
        self,
        *,
        namespace: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        updated_after: Optional[int] = None,
        updated_before: Optional[int] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
    ) -> List[Memory]:
        """Newest-first list. Optional date + metadata filters."""
        params = _build_list_params(
            q=None, namespace=namespace, limit=limit, offset=offset,
            created_after=created_after, created_before=created_before,
            updated_after=updated_after, updated_before=updated_before,
            metadata_filter=metadata_filter,
        )
        rows = _check_response(self._client.get("/api/memories", params=params)) or []
        return [Memory.from_dict(d) for d in rows]

    def get(self, memory_id: str) -> Optional[Memory]:
        """Fetch a single memory by id. Returns None on 404."""
        r = self._client.get(f"/api/memories/{memory_id}")
        if r.status_code == 404:
            return None
        return Memory.from_dict(_check_response(r))

    def update(
        self,
        memory_id: str,
        *,
        content: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        namespace: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Memory:
        """v0.2.2 partial update. ``metadata`` is MERGED into existing keys —
        pass ``{"key": None}`` to remove a metadata key.
        """
        body: Dict[str, Any] = {}
        if content is not None:    body["content"] = content
        if tags is not None:       body["tags"] = list(tags)
        if namespace is not None:  body["namespace"] = namespace
        if metadata is not None:   body["metadata"] = dict(metadata)
        if not body:
            raise MnueronError(0, "update() requires at least one field")
        return Memory.from_dict(
            _check_response(self._client.patch(f"/api/memories/{memory_id}", json=body))
        )

    def delete(self, memory_id: str) -> None:
        _check_response(self._client.delete(f"/api/memories/{memory_id}"))

    # -- namespaces / health -----------------------------------------------

    def namespaces(self) -> List[Namespace]:
        rows = _check_response(self._client.get("/api/namespaces")) or []
        return [Namespace(name=r["name"], count=int(r["count"]),
                          last_updated=int(r["last_updated"])) for r in rows]

    def health(self) -> bool:
        """Public liveness probe — no auth required for the path itself."""
        r = self._client.get("/api/health")
        if r.status_code != 200:
            return False
        try:
            return bool(r.json().get("ok"))
        except Exception:
            return False

    # -- webhooks (v0.3.1) -------------------------------------------------

    def list_webhooks(self) -> List[WebhookEndpoint]:
        payload = _check_response(self._client.get("/api/webhooks")) or {}
        return [WebhookEndpoint.from_dict(e) for e in (payload.get("endpoints") or [])]

    def create_webhook(
        self,
        url: str,
        *,
        events: Optional[Sequence[str]] = None,
        description: Optional[str] = None,
    ) -> WebhookEndpoint:
        """Register a webhook. Returns the row WITH ``secret`` populated —
        this is the only time the signing secret is exposed; record it now.
        """
        body: Dict[str, Any] = {"url": url}
        if events:           body["events"] = list(events)
        if description:      body["description"] = description
        return WebhookEndpoint.from_dict(
            _check_response(self._client.post("/api/webhooks", json=body))
        )

    def get_webhook(self, endpoint_id: str) -> Optional[WebhookEndpoint]:
        r = self._client.get(f"/api/webhooks/{endpoint_id}")
        if r.status_code == 404:
            return None
        return WebhookEndpoint.from_dict(_check_response(r))

    def update_webhook(
        self,
        endpoint_id: str,
        *,
        url: Optional[str] = None,
        events: Optional[Sequence[str]] = None,
        enabled: Optional[bool] = None,
        description: Optional[str] = None,
    ) -> None:
        body: Dict[str, Any] = {}
        if url is not None:         body["url"] = url
        if events is not None:      body["events"] = list(events)
        if enabled is not None:     body["enabled"] = enabled
        if description is not None: body["description"] = description
        if not body:
            raise MnueronError(0, "update_webhook() requires at least one field")
        _check_response(self._client.put(f"/api/webhooks/{endpoint_id}", json=body))

    def delete_webhook(self, endpoint_id: str) -> None:
        _check_response(self._client.delete(f"/api/webhooks/{endpoint_id}"))


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------

class AsyncMnueron:
    """Asyncio mirror of :class:`Mnueron`. Same surface, all methods awaitable."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 10.0,
    ):
        api_key = api_key or os.getenv("MNUERON_API_KEY") or os.getenv("MNUERON_API_TOKEN")
        if not api_key:
            raise MnueronError(0, "api_key not provided; set MNUERON_API_KEY or pass api_key=")
        base = (base_url or os.getenv("MNUERON_API_URL") or DEFAULT_BASE).rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=base,
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": _UA,
            },
            timeout=timeout,
        )

    async def __aenter__(self) -> "AsyncMnueron":
        return self

    async def __aexit__(self, *_exc) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    # -- memories ----------------------------------------------------------

    async def save(self, content: str, **kwargs: Any) -> Memory:
        body: Dict[str, Any] = {
            "content": content,
            "namespace": kwargs.get("namespace", "default"),
            "tags": list(kwargs.get("tags") or []),
            "source": kwargs.get("source", "sdk"),
        }
        for k in ("source_ref", "metadata"):
            if kwargs.get(k) is not None:
                body[k] = kwargs[k]
        return Memory.from_dict(_check_response(await self._client.post("/api/memories", json=body)))

    async def search(
        self,
        query: str,
        *,
        namespace: Optional[str] = None,
        k: int = 10,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        updated_after: Optional[int] = None,
        updated_before: Optional[int] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
    ) -> List[Memory]:
        params = _build_list_params(
            q=query, namespace=namespace, limit=k, offset=0,
            created_after=created_after, created_before=created_before,
            updated_after=updated_after, updated_before=updated_before,
            metadata_filter=metadata_filter,
        )
        rows = _check_response(await self._client.get("/api/memories", params=params)) or []
        return [Memory.from_dict(d) for d in rows]

    async def bulk_search(
        self,
        queries: Sequence[str],
        *,
        namespace: Optional[str] = None,
        k: int = 5,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
    ) -> List[BulkSearchResult]:
        body: Dict[str, Any] = {"queries": list(queries), "k": k}
        if namespace is not None:           body["namespace"] = namespace
        if created_after is not None:       body["created_after"] = int(created_after)
        if created_before is not None:      body["created_before"] = int(created_before)
        if metadata_filter is not None:     body["metadata_filter"] = dict(metadata_filter)
        payload = _check_response(await self._client.post("/api/memories/search/bulk", json=body)) or {}
        return [
            BulkSearchResult(
                query=row.get("query", ""),
                hits=[Memory.from_dict(h) for h in (row.get("hits") or [])],
            )
            for row in (payload.get("results") or [])
        ]

    async def list(
        self,
        *,
        namespace: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
        created_after: Optional[int] = None,
        created_before: Optional[int] = None,
        updated_after: Optional[int] = None,
        updated_before: Optional[int] = None,
        metadata_filter: Optional[Mapping[str, Any]] = None,
    ) -> List[Memory]:
        params = _build_list_params(
            q=None, namespace=namespace, limit=limit, offset=offset,
            created_after=created_after, created_before=created_before,
            updated_after=updated_after, updated_before=updated_before,
            metadata_filter=metadata_filter,
        )
        rows = _check_response(await self._client.get("/api/memories", params=params)) or []
        return [Memory.from_dict(d) for d in rows]

    async def get(self, memory_id: str) -> Optional[Memory]:
        r = await self._client.get(f"/api/memories/{memory_id}")
        if r.status_code == 404:
            return None
        return Memory.from_dict(_check_response(r))

    async def update(
        self,
        memory_id: str,
        *,
        content: Optional[str] = None,
        tags: Optional[Sequence[str]] = None,
        namespace: Optional[str] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Memory:
        body: Dict[str, Any] = {}
        if content is not None:    body["content"] = content
        if tags is not None:       body["tags"] = list(tags)
        if namespace is not None:  body["namespace"] = namespace
        if metadata is not None:   body["metadata"] = dict(metadata)
        if not body:
            raise MnueronError(0, "update() requires at least one field")
        return Memory.from_dict(
            _check_response(await self._client.patch(f"/api/memories/{memory_id}", json=body))
        )

    async def delete(self, memory_id: str) -> None:
        _check_response(await self._client.delete(f"/api/memories/{memory_id}"))

    # -- namespaces / health ----------------------------------------------

    async def namespaces(self) -> List[Namespace]:
        rows = _check_response(await self._client.get("/api/namespaces")) or []
        return [Namespace(name=r["name"], count=int(r["count"]),
                          last_updated=int(r["last_updated"])) for r in rows]

    async def health(self) -> bool:
        r = await self._client.get("/api/health")
        if r.status_code != 200:
            return False
        try:
            return bool(r.json().get("ok"))
        except Exception:
            return False

    # -- webhooks ---------------------------------------------------------

    async def list_webhooks(self) -> List[WebhookEndpoint]:
        payload = _check_response(await self._client.get("/api/webhooks")) or {}
        return [WebhookEndpoint.from_dict(e) for e in (payload.get("endpoints") or [])]

    async def create_webhook(
        self,
        url: str,
        *,
        events: Optional[Sequence[str]] = None,
        description: Optional[str] = None,
    ) -> WebhookEndpoint:
        body: Dict[str, Any] = {"url": url}
        if events:           body["events"] = list(events)
        if description:      body["description"] = description
        return WebhookEndpoint.from_dict(
            _check_response(await self._client.post("/api/webhooks", json=body))
        )

    async def get_webhook(self, endpoint_id: str) -> Optional[WebhookEndpoint]:
        r = await self._client.get(f"/api/webhooks/{endpoint_id}")
        if r.status_code == 404:
            return None
        return WebhookEndpoint.from_dict(_check_response(r))

    async def update_webhook(
        self,
        endpoint_id: str,
        *,
        url: Optional[str] = None,
        events: Optional[Sequence[str]] = None,
        enabled: Optional[bool] = None,
        description: Optional[str] = None,
    ) -> None:
        body: Dict[str, Any] = {}
        if url is not None:         body["url"] = url
        if events is not None:      body["events"] = list(events)
        if enabled is not None:     body["enabled"] = enabled
        if description is not None: body["description"] = description
        if not body:
            raise MnueronError(0, "update_webhook() requires at least one field")
        _check_response(await self._client.put(f"/api/webhooks/{endpoint_id}", json=body))

    async def delete_webhook(self, endpoint_id: str) -> None:
        _check_response(await self._client.delete(f"/api/webhooks/{endpoint_id}"))


# ---------------------------------------------------------------------------
# Webhook signature verification
# ---------------------------------------------------------------------------

def verify_webhook_signature(
    secret: str,
    body: bytes,
    signature_header: str,
) -> bool:
    """Verify an incoming mnueron webhook delivery.

    mnueron signs every webhook with HMAC-SHA256 over the raw request body
    and sends the hex digest in the ``X-Mnueron-Signature`` header (prefixed
    with ``sha256=``). Use this helper from your webhook handler::

        sig = request.headers["X-Mnueron-Signature"]
        if not verify_webhook_signature(secret, request.body, sig):
            return Response(status=401)

    The comparison is constant-time.
    """
    import hashlib
    import hmac

    if not signature_header:
        return False
    expected = "sha256=" + hmac.new(secret.encode("utf-8"), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature_header.strip())


__all__ = [
    "Mnueron",
    "AsyncMnueron",
    "Memory",
    "Namespace",
    "BulkSearchResult",
    "WebhookEndpoint",
    "MnueronError",
    "verify_webhook_signature",
    "DEFAULT_BASE",
]
