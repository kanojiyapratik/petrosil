"""Choosing which AI does the work.

The provider used to be whatever key was in the deployment's environment,
which meant nobody but a deployer could change it and there was no way to run
one site on a different model from another. It is configuration, so it lives
in the database and on a screen.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..ai.providers import PROVIDERS, AiProviderError, AiQuotaExhausted, create_driver
from ..db.store import ProviderStore, Store
from .routes import tone_for


def create_ai_routes(
    *,
    store: Store,
    providers: ProviderStore,
    templates: Jinja2Templates,
    current_user,
) -> APIRouter:
    router = APIRouter()

    def back(kind: str, text: str) -> RedirectResponse:
        return RedirectResponse(f"/console/settings/ai?{kind}={quote(text)}", status_code=303)

    def guard(request: Request):
        user = current_user(request)

        if user is None:
            return None, RedirectResponse("/console/login", status_code=303)

        if not user.is_admin:
            return user, templates.TemplateResponse(
                request,
                "error.html",
                {
                    "user": user,
                    "flash": None,
                    "site": None,
                    "section": None,
                    "crumbs": None,
                    "tone_for": tone_for,
                    "title": "Not allowed",
                    "message": "Only an administrator can change these settings.",
                },
                status_code=403,
            )

        return user, None

    @router.get("/console/settings/ai", response_class=HTMLResponse)
    def settings_ai(request: Request):
        user, response = guard(request)

        if response is not None:
            return response

        flash = None

        if request.query_params.get("ok"):
            flash = {"kind": "ok", "text": request.query_params["ok"]}
        elif request.query_params.get("err"):
            flash = {"kind": "bad", "text": request.query_params["err"]}

        rows = providers.all()

        return templates.TemplateResponse(
            request,
            "settings_ai.html",
            {
                "user": user,
                "flash": flash,
                "site": None,
                "section": "ai",
                "crumbs": [{"label": "Settings"}, {"label": "AI"}],
                "tone_for": tone_for,
                "title": "AI",
                "catalogue": PROVIDERS,
                "providers": rows,
                "sites": store.sites(),
                "assignments": providers.assignments(),
            },
        )

    @router.post("/console/settings/ai")
    async def add_provider(request: Request):
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()
        provider = str(form.get("provider") or "").lower()
        api_key = str(form.get("api_key") or "").strip()
        model = str(form.get("model") or "").strip()

        if provider not in PROVIDERS:
            return back("err", "Pick one of the providers offered.")

        if api_key == "":
            return back("err", "A provider needs an API key.")

        if model not in PROVIDERS[provider]["models"]:
            return back("err", f"{model or 'That model'} is not one of {PROVIDERS[provider]['label']}'s.")

        created = providers.create(
            name=str(form.get("name") or "").strip() or PROVIDERS[provider]["label"],
            provider=provider,
            api_key=api_key,
            model=model,
            make_default=form.get("make_default") in ("on", "1") or not providers.all(),
        )

        # The key itself is never recorded, only that one was added.
        store.record(user.email, "added an AI provider", None, f"{created.name} ({model})")

        return back("ok", f"{created.name} added.")

    @router.post("/console/settings/ai/{provider_id}")
    async def update_provider(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()
        existing = providers.get(provider_id)

        if existing is None:
            return back("err", "No such provider.")

        model = str(form.get("model") or existing.model)

        if model not in PROVIDERS.get(existing.provider, {}).get("models", [model]):
            return back("err", "That model is not one this provider offers.")

        providers.update(
            provider_id,
            name=str(form.get("name") or existing.name),
            model=model,
            # Blank means keep the stored key: the screen only ever shows a
            # masked version, so submitting the form must not overwrite the
            # real key with dots.
            api_key=str(form.get("api_key") or "").strip(),
            enabled=str(form.get("enabled") or "1") == "1",
        )
        store.record(user.email, "updated an AI provider", None, existing.name)

        return back("ok", f"{existing.name} saved.")

    @router.post("/console/settings/ai/{provider_id}/default")
    def set_default(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        existing = providers.get(provider_id)

        if existing is None:
            return back("err", "No such provider.")

        providers.make_default(provider_id)
        store.record(user.email, "changed the default AI provider", None, existing.name)

        return back("ok", f"{existing.name} is now the default.")

    @router.post("/console/settings/ai/{provider_id}/delete")
    def delete_provider(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        existing = providers.get(provider_id)

        if existing is None:
            return back("err", "No such provider.")

        if existing.is_default:
            return back("err", "That is the default — make another one the default first.")

        providers.delete(provider_id)
        store.record(user.email, "removed an AI provider", None, existing.name)

        return back("ok", f"{existing.name} removed. Sites using it fall back to the default.")

    @router.post("/console/settings/ai/{provider_id}/test")
    def test_provider(request: Request, provider_id: int):
        """Ask the model something trivial and report what came back.

        Worth its own button: a wrong key, a wrong model name and an exhausted
        quota all look identical from the crawler screen hours later, and this
        answers in a second for the price of one tiny call.
        """
        user, response = guard(request)

        if response is not None:
            return response

        existing = providers.get(provider_id)

        if existing is None:
            return back("err", "No such provider.")

        try:
            completion = create_driver(
                existing.provider, existing.api_key, existing.model
            ).generate("Reply with the single word: ready")
        except AiQuotaExhausted as error:
            return back("err", f"{existing.name}: {error}")
        except AiProviderError as error:
            return back("err", f"{existing.name}: {error}")

        if completion.status != "complete":
            return back("err", f"{existing.name} answered but declined: {completion.error}")

        return back(
            "ok",
            f"{existing.name} works — {existing.model} replied "
            f'"{(completion.text or "").strip()[:40]}".',
        )

    @router.post("/console/settings/ai/site/{slug}")
    async def assign_to_site(request: Request, slug: str):
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()
        raw = str(form.get("provider_id") or "").strip()
        site = store.site_by_slug(slug)

        if site is None:
            return back("err", "No such site.")

        provider_id = int(raw) if raw.isdigit() else None
        providers.assign_to_site(slug, provider_id)

        chosen = providers.get(provider_id).name if provider_id else "the default"
        store.record(user.email, "chose an AI provider for a site", slug, chosen)

        return back("ok", f"{site.name} now uses {chosen}.")

    return router
