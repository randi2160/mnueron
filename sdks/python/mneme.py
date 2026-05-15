"""
mneme — Python SDK for the mneme memory backend.

Wraps the hosted HTTP API. For local SQLite mode (no account, free forever),
use the `mneme` CLI or the MCP server directly. This SDK requires a hosted
backend URL + API token.

    pip install mneme

    from mneme import Mneme
    with Mneme(api_key="mn_xxx") as client:
        client.save("User prefers concise replies", namespace="my-app")
        results = client.search("what does user prefer?", namespace="my-app")
        for r in results:
            print(r.content, r.score)
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

import httpx


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Memory:
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
            namespace=d["namespace"],
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
class BulkResult:
    saved: int
    errors: int


class MnemeError(Exception):
    """Raised when the API returns a non-2xx response."""
    def __init__(self, status: int, message: str):
        self.status = status
        super().__init__(f"mneme API {status}: {message}")


# ---------------------------------------------------------------------------
# Sync client
# ---------------------------------------------------------------------------

class Mneme:
    """Synchronous client. Use ``with Mneme(...) as client:`` for cleanup."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 10.0,
    ):
        api_key = api_key or os.getenv("MNEME_API_KEY") or os.getenv("MNEME_API_TOKEN")
        if not api_key:
            raise MnemeError(0, "api_key not provided; set MNEME_API_KEY or pass api_key=")
        base_url = (base_url or os.getenv("MNEME_API_URL") or "https://api.mneme.dev").rstrip("/")
        self._client = httpx.Client(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "mneme-python/0.1",
            },
            timeout=timeout,
        )

    def __enter__(self) -> "Mneme":
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # -- internals -----------------------------------------------------------

    def _check(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            raise MnemeError(r.status_code, r.text or r.reason_phrase)
        if r.status_code == 204 or not r.content:
            return None
        return r.json()

    # -- API ---------------------------------------------------------------

    def save(
        self,
        content: str,
        *,
        namespace: str = "default",
        tags: Optional[List[str]] = None,
        source: str = "sdk",
        source_ref: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Memory:
        body: Dict[str, Any] = {
            "content": content,
            "namespace": namespace,
            "tags": tags or [],
            "source": source,
        }
        if source_ref is not None:
            body["source_ref"] = source_ref
        if metadata is not None:
            body["metadata"] = metadata
        return Memory.from_dict(self._check(self._client.post("/v1/memories", json=body)))

    def search(
        self,
        query: str,
        *,
        namespace: Optional[str] = None,
        k: int = 10,
        tags: Optional[List[str]] = None,
    ) -> List[Memory]:
        body: Dict[str, Any] = {"query": query, "k": k}
        if namespace is not None:
            body["namespace"] = namespace
        if tags:
            body["tags"] = tags
        rows = self._check(self._client.post("/v1/memories/search", json=body)) or []
        return [Memory.from_dict(d) for d in rows]

    def list(
        self,
        *,
        namespace: Optional[str] = None,
        limit: int = 50,
        before: Optional[int] = None,
    ) -> List[Memory]:
        params: Dict[str, Any] = {"limit": limit}
        if namespace is not None:
            params["namespace"] = namespace
        if before is not None:
            params["before"] = before
        rows = self._check(self._client.get("/v1/memories", params=params)) or []
        return [Memory.from_dict(d) for d in rows]

    def get(self, memory_id: str) -> Optional[Memory]:
        d = self._check(self._client.get(f"/v1/memories/{memory_id}"))
        return Memory.from_dict(d) if d else None

    def delete(self, memory_id: str) -> None:
        self._check(self._client.delete(f"/v1/memories/{memory_id}"))

    def namespaces(self) -> List[Namespace]:
        rows = self._check(self._client.get("/v1/namespaces")) or []
        return [Namespace(**d) for d in rows]

    def bulk_save(self, items: Iterable[Dict[str, Any]]) -> BulkResult:
        body = {"items": list(items)}
        d = self._check(self._client.post("/v1/memories/bulk", json=body))
        return BulkResult(saved=d.get("saved", 0), errors=d.get("errors", 0))


# ---------------------------------------------------------------------------
# Async client
# ---------------------------------------------------------------------------

class AsyncMneme:
    """Asyncio client. Use ``async with AsyncMneme(...) as client:`` for cleanup."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: float = 10.0,
    ):
        api_key = api_key or os.getenv("MNEME_API_KEY") or os.getenv("MNEME_API_TOKEN")
        if not api_key:
            raise MnemeError(0, "api_key not provided; set MNEME_API_KEY or pass api_key=")
        base_url = (base_url or os.getenv("MNEME_API_URL") or "https://api.mneme.dev").rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=base_url,
            headers={
                "Authorization": f"Bearer {api_key}",
                "User-Agent": "mneme-python/0.1",
            },
            timeout=timeout,
        )

    async def __aenter__(self) -> "AsyncMneme":
        return self

    async def __aexit__(self, *_exc) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.aclose()

    def _check(self, r: httpx.Response) -> Any:
        if r.status_code >= 400:
            raise MnemeError(r.status_code, r.text or r.reason_phrase)
        if r.status_code == 204 or not r.content:
            return None
        return r.json()

    async def save(self, content: str, **kwargs: Any) -> Memory:
        body: Dict[str, Any] = {
            "content": content,
            "namespace": kwargs.get("namespace", "default"),
            "tags": kwargs.get("tags") or [],
            "source": kwargs.get("source", "sdk"),
        }
        for k in ("source_ref", "metadata"):
            if kwargs.get(k) is not None:
                body[k] = kwargs[k]
        return Memory.from_dict(self._check(await self._client.post("/v1/memories", json=body)))

    async def search(
        self,
        query: str,
        *,
        namespace: Optional[str] = None,
        k: int = 10,
        tags: Optional[List[str]] = None,
    ) -> List[Memory]:
        body: Dict[str, Any] = {"query": query, "k": k}
        if namespace is not None:
            body["namespace"] = namespace
        if tags:
            body["tags"] = tags
        rows = self._check(await self._client.post("/v1/memories/search", json=body)) or []
        return [Memory.from_dict(d) for d in rows]

    async def list(self, *, namespace: Optional[str] = None, limit: int = 50,
                   before: Optional[int] = None) -> List[Memory]:
        params: Dict[str, Any] = {"limit": limit}
        if namespace is not None:
            params["namespace"] = namespace
        if before is not None:
            params["before"] = before
        rows = self._check(await self._client.get("/v1/memories", params=params)) or []
        return [Memory.from_dict(d) for d in rows]

    async def delete(self, memory_id: str) -> None:
        self._check(await self._client.delete(f"/v1/memories/{memory_id}"))

    async def namespaces(self) -> List[Namespace]:
        rows = self._check(await self._client.get("/v1/namespaces")) or []
        return [Namespace(**d) for d in rows]


__all__ = ["Mneme", "AsyncMneme", "Memory", "Namespace", "BulkResult", "MnemeError"]
