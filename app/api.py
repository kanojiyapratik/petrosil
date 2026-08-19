"""The JSON API, byte-for-byte the same contract the TypeScript version served.

`/api/price-reviews` is live and called by baseoil's PriceReviewGateway, so
the field names, the status codes and the envelope shape are not ours to
change during a port. The tests pin all three.
"""

from __future__ import annotations

import hmac
import re
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .ai.gemini import AiProviderError
from .ai.prompt import render_prompt
from .price_review.differ import CurrentPrice, ProposedRow, diff_prices, js_number
from .price_review.summariser import Move, PriceSummary, summarise

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Row(BaseModel):
    location: str
    # A sheet cell can hold anything; the differ decides what counts.
    price: Any = None


class CurrentPriceIn(BaseModel):
    location: str
    price: float


class PriceReviewRequest(BaseModel):
    """Snake_case on the wire -- the callers are PHP sites."""

    price_date: str
    rows: list[Row] = Field(min_length=1, max_length=5000)
    current_prices: list[CurrentPriceIn] = []
    valid_locations: list[str] = []
    title: str | None = None
    model: str | None = None


def create_api(*, api_token: str, driver, default_model: str) -> APIRouter:
    router = APIRouter()

    def authorise(authorization: str | None = Header(default=None)) -> None:
        """One shared bearer token in front of every /api route.

        Fails closed: an empty configured token rejects every request rather
        than letting them through as if auth were disabled. Compared in
        constant time so the token cannot be probed by timing.
        """
        provided = re.sub(r"^Bearer\s+", "", authorization or "", flags=re.IGNORECASE)

        if api_token == "" or provided == "" or not hmac.compare_digest(provided, api_token):
            raise HTTPException(status_code=401, detail="Unauthenticated.")

    @router.get("/api/models", dependencies=[Depends(authorise)])
    def models() -> list[dict]:
        """The model picker on the calling site's preview page. Only google is
        configured; the shape keeps the `available` flag so a site can grey out
        a provider rather than offer one that would fail."""
        return [
            {
                "provider": "google",
                "label": "Google Gemini",
                "available": True,
                "models": [
                    {"key": "gemini-2.5-flash", "label": "Gemini 2.5 Flash"},
                    {"key": "gemini-2.5-flash-lite", "label": "Gemini 2.5 Flash Lite"},
                    {"key": "gemini-2.5-pro", "label": "Gemini 2.5 Pro"},
                ],
            }
        ]

    @router.post("/api/price-reviews", dependencies=[Depends(authorise)])
    async def price_reviews(request: Request) -> JSONResponse:
        payload = await request.json()

        try:
            body = PriceReviewRequest(**payload)
        except Exception as error:  # noqa: BLE001 - shape errors become 422, not 500
            return JSONResponse(
                {"message": "The request is invalid.", "errors": str(error)}, status_code=422
            )

        if not ISO_DATE.match(body.price_date):
            return JSONResponse(
                {
                    "message": "The request is invalid.",
                    "errors": {"price_date": ["price_date must be YYYY-MM-DD"]},
                },
                status_code=422,
            )

        rows = diff_prices(
            price_date=body.price_date,
            rows=[ProposedRow(location=row.location, price=row.price) for row in body.rows],
            current_prices=[
                CurrentPrice(location=entry.location, price=entry.price)
                for entry in body.current_prices
            ],
            valid_locations=body.valid_locations,
        )

        summary = summarise(rows, body.price_date)
        title = body.title or f"Price update — {body.price_date}"
        model = body.model or default_model

        # The diff and the figures are this module's own work: they stay valid
        # even when the provider is unreachable, so a failed narration still
        # returns a usable preview rather than nothing.
        status = 201

        try:
            completion = driver.generate(model, render_prompt("price_batch", title, _present_summary(summary)))
            analysis = {
                "status": completion.status,
                "output_markdown": completion.text,
                "model": model,
                "prompt_tokens": completion.prompt_tokens,
                "completion_tokens": completion.completion_tokens,
                "error": completion.error,
            }
        except (AiProviderError, Exception) as error:  # noqa: BLE001
            status = 502
            analysis = {
                "status": "failed",
                "output_markdown": None,
                "model": model,
                "prompt_tokens": None,
                "completion_tokens": None,
                "error": str(error),
            }

        return JSONResponse(
            {
                "rows": [
                    {
                        "location": row.location,
                        "old_price": js_number(row.old_price),
                        "new_price": None if row.new_price != row.new_price else js_number(row.new_price),
                        "status": row.status,
                    }
                    for row in rows
                ],
                "summary": _present_summary(summary),
                "analysis": analysis,
            },
            status_code=status,
        )

    return router


def _present_move(move: Move | None) -> dict | None:
    if move is None:
        return None

    return {
        "location": move.location,
        "old": js_number(move.old),
        "new": js_number(move.new),
        "change_pct": js_number(move.change_pct),
    }


def _present_summary(summary: PriceSummary) -> dict:
    return {
        "total_rows": summary.total_rows,
        "price_date": summary.price_date,
        "by_status": summary.by_status,
        "changes": {
            "rose": summary.changes.rose,
            "fell": summary.changes.fell,
            "median_change_pct": js_number(summary.changes.median_change_pct),
            "largest_rise": _present_move(summary.changes.largest_rise),
            "largest_fall": _present_move(summary.changes.largest_fall),
        },
        "suspected_errors": [
            {
                "location": error.location,
                "old_price": js_number(error.old_price),
                "new_price": None if error.new_price != error.new_price else js_number(error.new_price),
                "status": error.status,
                "reason": error.reason,
            }
            for error in summary.suspected_errors
        ],
    }
