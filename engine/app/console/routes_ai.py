"""Choosing which AI does the work.

The provider used to be whatever key was in the deployment's environment,
which meant nobody but a deployer could change it and there was no way to run
one site on a different model from another. It is configuration, so it lives
in the database and on a screen.
"""

from __future__ import annotations

from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from ..ai.providers import (
    PROVIDERS,
    AiProviderError,
    AiQuotaExhausted,
    available_models,
    create_driver,
)
from ..db.store import ProviderStore, Store
from .access import managed_site, may_change_settings, visible_sites
from .routes import tone_for


def clean_key(raw) -> str:
    """An API key with every space and line break taken out.

    A key pasted out of a chat message or a wrapped email arrives with a
    newline or a space in the middle of it. .strip() only trims the ends, so
    the broken key saved cleanly, masked identically on screen -- the mask
    shows four characters at each end -- and was rejected by the provider with
    no clue as to why. No provider issues keys containing whitespace, so
    removing all of it can only repair a paste, never damage a real key.
    """
    return "".join(str(raw or "").split())


def create_ai_routes(
    *,
    store: Store,
    providers: ProviderStore,
    templates: Jinja2Templates,
    current_user,
    usage=None,
) -> APIRouter:
    router = APIRouter()

    def back(kind: str, text: str) -> RedirectResponse:
        return RedirectResponse(f"/console/settings/ai?{kind}={quote(text)}", status_code=303)

    def guard(request: Request):
        user = current_user(request)

        if user is None:
            return None, RedirectResponse("/console/login", status_code=303)

        if not may_change_settings(user):
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
        # Each saved key is asked what it can actually run, so the list is the
        # account's own and cannot go stale. The hardcoded catalogue is only
        # the fallback -- and the starting point for a provider being added,
        # where there is no key yet to ask.
        offered = {}

        for row in rows:
            live = available_models(row.provider, row.api_key)
            fallback = PROVIDERS.get(row.provider, {}).get("models", [])
            offered[row.id] = live or fallback

            # Whatever is in use stays selectable even if the listing missed it.
            if row.model not in offered[row.id]:
                offered[row.id] = [row.model] + list(offered[row.id])

        return templates.TemplateResponse(
            request,
            "settings_ai.html",
            {
                "offered": offered,
                "user": user,
                "flash": flash,
                "site": None,
                "section": "ai",
                "crumbs": [{"label": "Settings"}, {"label": "AI"}],
                "tone_for": tone_for,
                "title": "AI",
                "catalogue": PROVIDERS,
                "providers": rows,
                # Only the sites this person may use: the AI screen is the
                # third place sites are listed, and a list is as good a way to
                # learn a site exists as its own address.
                "sites": visible_sites(store, user, store.sites()),
                "assignments": providers.assignments(),
                "site_models": providers.site_models(),
                "usage_days": usage.by_day(14) if usage is not None else [],
            },
        )

    @router.post("/console/settings/ai/check-key")
    async def check_key(request: Request):
        """What a key being typed into the add-a-key form can actually run.

        Before this, the add-a-key form could only offer the hardcoded
        catalogue, because there was no saved key yet to ask -- the live list
        only appeared after the row existed. This lets the form ask the key
        itself, the same way a saved row already does.

        The key here is never saved, never logged and never echoed back:
        available_models never raises and never carries the key in what it
        returns, so a failure here is always the same clean "not accepted",
        not a provider's own error text.
        """
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()
        provider = str(form.get("provider") or "").lower()
        api_key = clean_key(form.get("api_key"))

        if provider not in PROVIDERS or api_key == "":
            return JSONResponse({"ok": False, "error": "That key was not accepted."})

        # Short: a person is waiting on this form to fill in.
        live = available_models(provider, api_key, timeout_seconds=6)

        if not live:
            return JSONResponse({"ok": False, "error": "That key was not accepted."})

        return JSONResponse({"ok": True, "models": live})

    @router.post("/console/settings/ai")
    async def add_provider(request: Request):
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()
        provider = str(form.get("provider") or "").lower()
        api_key = clean_key(form.get("api_key"))
        model = str(form.get("model") or "").strip()

        if provider not in PROVIDERS:
            return back("err", "Pick one of the providers offered.")

        if api_key == "":
            return back("err", "A provider needs an API key.")

        # The key being added is the authority on what it can run; the
        # catalogue is only consulted when the provider cannot be asked.
        allowed = available_models(provider, api_key) or PROVIDERS[provider]["models"]

        # The add form no longer asks for a model -- it is changed on the
        # provider's row afterwards. Start on the provider's usual model when
        # this key can run it, else on the first one the key offers.
        if model == "":
            usual = [m for m in PROVIDERS[provider]["models"] if m in allowed]
            model = usual[0] if usual else allowed[0]

        if model not in allowed:
            return back(
                "err", f"{model or 'That model'} is not one {PROVIDERS[provider]['label']} offers."
            )

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

    @router.post("/console/settings/ai/{provider_id}/reveal")
    def reveal_key(request: Request, provider_id: int):
        """The stored key in full, for an administrator who asks for it.

        The screen masks a key everywhere else, and that is still right: a key
        readable off a screen leaks through a screenshot. But masking made one
        question unanswerable -- "is the key here the same one that works over
        there?" -- because the mask shows four characters at each end, which
        every key of a given provider shares. An afternoon went into a key that
        looked identical and was not.

        So: never in the page as rendered, only on a deliberate request, only
        for an administrator, and always written to the audit trail. Someone
        reading the trail can see who looked and when.
        """
        user, response = guard(request)

        if response is not None:
            return response

        existing = providers.get(provider_id)

        if existing is None:
            return JSONResponse({"ok": False, "error": "No such provider."}, status_code=404)

        # Looking at a credential is an event worth recording, even when the
        # person is entitled to it.
        store.record(user.email, "revealed an AI provider key", None, existing.name)

        return JSONResponse({"ok": True, "api_key": existing.api_key})

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
        allowed = (
            available_models(existing.provider, clean_key(form.get("api_key")) or existing.api_key)
            or PROVIDERS.get(existing.provider, {}).get("models", [])
            or [model]
        )

        if model != existing.model and model not in allowed:
            return back("err", "That model is not one this provider offers.")

        providers.update(
            provider_id,
            name=str(form.get("name") or existing.name),
            model=model,
            # Blank means keep the stored key: the screen only ever shows a
            # masked version, so submitting the form must not overwrite the
            # real key with dots.
            api_key=clean_key(form.get("api_key")),
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

        def note(status, completion=None):
            if usage is not None:
                usage.record(
                    kind="provider_test",
                    provider=existing.provider,
                    model=existing.model,
                    status=status,
                    prompt_tokens=completion.prompt_tokens if completion else None,
                    completion_tokens=completion.completion_tokens if completion else None,
                )

        try:
            completion = create_driver(
                existing.provider, existing.api_key, existing.model
            ).generate("Reply with the single word: ready")
            note(completion.status, completion)
        except AiQuotaExhausted as error:
            note("failed")

            return back("err", f"{existing.name}: {error}")
        except AiProviderError as error:
            note("failed")

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
        # managed_site, so a hidden site can still be given a provider, and so
        # a slug outside this person's own sites reads as "no such site".
        site = managed_site(store, user, slug)

        if site is None:
            return back("err", "No such site.")

        provider_id = int(raw) if raw.isdigit() else None
        provider = providers.get(provider_id) if provider_id else None

        if provider_id and provider is None:
            return back("err", "That provider no longer exists.")

        # Blank means the provider's own model. A model of its own is only
        # kept with a provider picked for this site -- see ProviderStore.
        model = str(form.get("model") or "").strip() if provider else ""

        # Picking the provider's own model is the same as not picking one, and
        # stored blank it follows the provider when its model is changed.
        if provider and model == provider.model:
            model = ""

        # A model this key cannot run would only fail later, in the middle of
        # a price update, so it is refused here.
        if model:
            allowed = available_models(provider.provider, provider.api_key) or PROVIDERS.get(
                provider.provider, {}
            ).get("models", [])

            if model not in allowed:
                return back("err", f"{provider.name} cannot run {model}.")

        providers.assign_to_site(slug, provider_id, model or None)

        chosen = (
            f"{provider.name} ({model or provider.model})" if provider else "the default"
        )
        store.record(user.email, "chose an AI provider for a site", slug, chosen)

        return back("ok", f"{site.name} now uses {chosen}.")

    return router
