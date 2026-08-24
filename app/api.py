"""The JSON API, byte-for-byte the same contract the TypeScript version served.

`/api/price-reviews` is live and called by baseoil's PriceReviewGateway, so
the field names, the status codes and the envelope shape are not ours to
change during a port. The tests pin all three.
"""

from __future__ import annotations

import hmac
import json
import re
from typing import Any

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .ai.gemini import AiProviderError
from .ai.prompt import render_prompt
from .editorial.extract import document_to_text
from .editorial.review import ParsedSuggestions, build_rows, editorial_prompt, parse_suggestions
from .price_review.differ import CurrentPrice, ProposedRow, diff_prices, js_number
from .price_review.summariser import Move, PriceSummary, summarise

ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

MAX_DOCUMENTS = 5
MAX_DOCUMENT_BYTES = 10 * 1024 * 1024


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


class EditorialCurrentPrice(BaseModel):
    location: str
    # A location can be tracked without a published price yet.
    price: float | None = None


class EditorialReviewRequest(BaseModel):
    """The JSON half of the multipart /api/editorial-reviews request."""

    price_date: str
    current_prices: list[EditorialCurrentPrice] = Field(min_length=1, max_length=500)
    title: str | None = None
    model: str | None = None


def create_api(*, api_token: str, driver, default_model: str, driver_for=None) -> APIRouter:
    """driver_for() lets the deployment choose a model per request -- the
    console stores one in its database, and an admin changing it should not
    need a redeploy. Falls back to the driver built at boot."""
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

        chosen = driver_for() if driver_for is not None else None
        active = chosen or driver

        if chosen is not None and body.model is None:
            model = getattr(chosen, "model", model)

        try:
            prompt = render_prompt("price_batch", title, _present_summary(summary))
            # The boot driver takes the model per call; a configured one
            # already knows which model it is.
            completion = (
                active.generate(prompt)
                if chosen is not None
                else active.generate(model, prompt)
            )
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

    @router.post("/api/editorial-reviews", dependencies=[Depends(authorise)])
    async def editorial_reviews(
        payload: str = Form(...),
        documents: list[UploadFile] = File(...),
    ) -> JSONResponse:
        """Market reports in, a per-location price draft out.

        Unlike /api/price-reviews there is no useful partial result without
        the model -- the suggestions ARE the output -- so a provider failure
        is a plain 502.
        """

        def invalid(errors) -> JSONResponse:
            return JSONResponse(
                {"message": "The request is invalid.", "errors": errors}, status_code=422
            )

        try:
            body = EditorialReviewRequest(**json.loads(payload))
        except Exception as error:  # noqa: BLE001 - shape errors become 422, not 500
            return invalid(str(error))

        if not ISO_DATE.match(body.price_date):
            return invalid({"price_date": ["price_date must be YYYY-MM-DD"]})

        if len(documents) > MAX_DOCUMENTS:
            return invalid({"documents": [f"At most {MAX_DOCUMENTS} documents per review."]})

        texts = []

        for document in documents:
            raw = await document.read()

            if len(raw) > MAX_DOCUMENT_BYTES:
                return invalid({"documents": [f"{document.filename} is larger than 10 MB."]})

            text = document_to_text(document.filename or "", raw)

            if text.strip():
                texts.append(text)

        if not texts:
            return invalid(
                {"documents": ["No document could be read. Upload .docx, .xlsx, .pdf or .txt files."]}
            )

        locations = [entry.location for entry in body.current_prices]
        current = {
            entry.location: entry.price
            for entry in body.current_prices
            if entry.price is not None
        }

        model = body.model or default_model
        chosen = driver_for() if driver_for is not None else None
        active = chosen or driver

        if chosen is not None and body.model is None:
            model = getattr(chosen, "model", model)

        prompt = editorial_prompt(locations, texts)
        status = 201

        try:
            completion = (
                active.generate(prompt) if chosen is not None else active.generate(model, prompt)
            )
            analysis = {
                "status": completion.status,
                "model": model,
                "prompt_tokens": completion.prompt_tokens,
                "completion_tokens": completion.completion_tokens,
                "error": completion.error,
            }
            parsed = (
                parse_suggestions(completion.text, locations)
                if completion.status == "complete"
                else ParsedSuggestions()
            )
        except (AiProviderError, Exception) as error:  # noqa: BLE001
            status = 502
            analysis = {
                "status": "failed",
                "model": model,
                "prompt_tokens": None,
                "completion_tokens": None,
                "error": str(error),
            }
            parsed = ParsedSuggestions()

        rows = build_rows(locations, current, parsed)
        near_matches = sum(1 for row in rows if row["status"] == "near_match")

        return JSONResponse(
            {
                "rows": rows,
                "summary": {
                    "price_date": body.price_date,
                    "total_locations": len(locations),
                    "suggested": sum(1 for row in rows if row["status"] == "suggested"),
                    "near_match": near_matches,
                    "no_evidence": sum(1 for row in rows if row["status"] == "no_evidence"),
                    "invalid": sum(1 for row in rows if row["status"] == "invalid"),
                    "flagged": sum(1 for row in rows if row["flag"] is not None),
                    "dropped_unknown": len(parsed.unmatched) - near_matches,
                },
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
