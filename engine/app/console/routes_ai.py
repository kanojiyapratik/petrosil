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
from .flows import FlowError
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


def models_offered(provider) -> list[str]:
    """What this provider's key can actually run, asked of the provider, so
    the list cannot go stale; the catalogue is only the fallback. Whatever
    is in use stays selectable even if the listing missed it."""
    offered = available_models(provider.provider, provider.api_key) or PROVIDERS.get(
        provider.provider, {}
    ).get("models", [])

    return offered if provider.model in offered else [provider.model, *offered]


def site_ai_view(slug: str, *, providers: ProviderStore) -> dict:
    """One site's AI choice, for the app's AI settings screen: the
    providers it may pick from -- never their keys -- and what it has
    picked. No provider of its own means the default one."""
    return {
        "providers": [
            {
                "id": row.id,
                "name": row.name,
                "provider": PROVIDERS.get(row.provider, {}).get("label", row.provider),
                "model": row.model,
                "is_default": row.is_default,
                "models": models_offered(row),
            }
            for row in providers.all()
            if row.enabled
        ],
        "provider_id": providers.assignments().get(slug),
        "model": providers.site_models().get(slug),
    }


def assign_site_model(
    site, actor: str, *, providers: ProviderStore, store, raw_provider_id: str, raw_model: str
) -> str:
    """Which provider, and which of its models, this site's AI work runs on.
    Blank means the default provider."""
    raw = raw_provider_id.strip()
    provider_id = int(raw) if raw.isdigit() else None
    provider = providers.get(provider_id) if provider_id else None

    if provider_id and provider is None:
        raise FlowError("That provider no longer exists.", 422)

    # Blank means the provider's own model. A model of its own is only
    # kept with a provider picked for this site -- see ProviderStore.
    model = raw_model.strip() if provider else ""

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
            raise FlowError(f"{provider.name} cannot run {model}.", 422)

    providers.assign_to_site(site.slug, provider_id, model or None)

    chosen = f"{provider.name} ({model or provider.model})" if provider else "the default"
    store.record(actor, "chose an AI provider for a site", site.slug, chosen)

    return f"{site.name} now uses {chosen}."


def providers_view(*, providers: ProviderStore) -> dict:
    """Every provider as the settings screen lists it: the key masked,
    what the key can run, and which sites chose it. Never the key itself."""
    assignments = providers.assignments()

    return {
        "catalogue": {
            key: {"label": entry["label"], "key_hint": entry.get("key_hint", "")}
            for key, entry in PROVIDERS.items()
        },
        "providers": [
            {
                "id": row.id,
                "name": row.name,
                "provider": row.provider,
                "label": PROVIDERS.get(row.provider, {}).get("label", row.provider),
                "model": row.model,
                "masked_key": row.masked_key,
                "enabled": row.enabled,
                "is_default": row.is_default,
                "models": models_offered(row),
                "sites": sorted(slug for slug, pid in assignments.items() if pid == row.id),
            }
            for row in providers.all()
        ],
    }


def models_for_new_key(provider: str, raw_key) -> list[str]:
    """What a key being typed in can run. The key is never saved, logged or
    echoed: available_models never raises and never carries it in what it
    returns, so a failure is always the same clean "not accepted"."""
    provider = str(provider or "").lower()
    api_key = clean_key(raw_key)

    if provider not in PROVIDERS or api_key == "":
        raise FlowError("That key was not accepted.", 422)

    # Short: a person is waiting on this form to fill in.
    live = available_models(provider, api_key, timeout_seconds=6)

    if not live:
        raise FlowError("That key was not accepted.", 422)

    return live


def add_provider(
    actor: str, *, providers: ProviderStore, store, provider: str, raw_key, name: str = "",
    model: str = "", make_default: bool = False,
) -> str:
    provider = str(provider or "").lower()
    api_key = clean_key(raw_key)
    model = str(model or "").strip()

    if provider not in PROVIDERS:
        raise FlowError("Pick one of the providers offered.", 422)

    if api_key == "":
        raise FlowError("A provider needs an API key.", 422)

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
        raise FlowError(f"{model or 'That model'} is not one {PROVIDERS[provider]['label']} offers.", 422)

    created = providers.create(
        name=str(name or "").strip() or PROVIDERS[provider]["label"],
        provider=provider,
        api_key=api_key,
        model=model,
        make_default=make_default or not providers.all(),
    )

    # The key itself is never recorded, only that one was added.
    store.record(actor, "added an AI provider", None, f"{created.name} ({model})")

    return f"{created.name} added."


def update_provider(
    actor: str, provider_id: int, *, providers: ProviderStore, store, name: str = "", model: str = "",
    raw_key=None, enabled: bool = True,
) -> str:
    existing = providers.get(provider_id)

    if existing is None:
        raise FlowError("No such provider.", 404)

    model = str(model or existing.model)
    allowed = (
        available_models(existing.provider, clean_key(raw_key) or existing.api_key)
        or PROVIDERS.get(existing.provider, {}).get("models", [])
        or [model]
    )

    if model != existing.model and model not in allowed:
        raise FlowError("That model is not one this provider offers.", 422)

    providers.update(
        provider_id,
        name=str(name or existing.name),
        model=model,
        # Blank means keep the stored key: the screen only ever shows a
        # masked version, so submitting the form must not overwrite the
        # real key with dots.
        api_key=clean_key(raw_key),
        enabled=enabled,
    )
    store.record(actor, "updated an AI provider", None, existing.name)

    return f"{existing.name} saved."


def make_default_provider(actor: str, provider_id: int, *, providers: ProviderStore, store) -> str:
    existing = providers.get(provider_id)

    if existing is None:
        raise FlowError("No such provider.", 404)

    providers.make_default(provider_id)
    store.record(actor, "changed the default AI provider", None, existing.name)

    return f"{existing.name} is now the default."


def remove_provider(actor: str, provider_id: int, *, providers: ProviderStore, store) -> str:
    existing = providers.get(provider_id)

    if existing is None:
        raise FlowError("No such provider.", 404)

    if existing.is_default:
        raise FlowError("That is the default — make another one the default first.", 409)

    providers.delete(provider_id)
    store.record(actor, "removed an AI provider", None, existing.name)

    return f"{existing.name} removed. Sites using it fall back to the default."


def test_provider(provider_id: int, *, providers: ProviderStore, usage=None) -> str:
    """Ask the model something trivial and report what came back.

    Worth its own button: a wrong key, a wrong model name and an exhausted
    quota all look identical from the crawler screen hours later, and this
    answers in a second for the price of one tiny call.
    """
    existing = providers.get(provider_id)

    if existing is None:
        raise FlowError("No such provider.", 404)

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
        completion = create_driver(existing.provider, existing.api_key, existing.model).generate(
            "Reply with the single word: ready"
        )
        note(completion.status, completion)
    except (AiQuotaExhausted, AiProviderError) as error:
        note("failed")

        raise FlowError(f"{existing.name}: {error}", 502) from error

    if completion.status != "complete":
        raise FlowError(f"{existing.name} answered but declined: {completion.error}", 502)

    return f'{existing.name} works — {existing.model} replied "{(completion.text or "").strip()[:40]}".'


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
        See models_for_new_key: the key is never saved, logged or echoed."""
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()

        try:
            return JSONResponse({"ok": True, "models": models_for_new_key(form.get("provider"), form.get("api_key"))})
        except FlowError as refused:
            return JSONResponse({"ok": False, "error": refused.message})

    @router.post("/console/settings/ai")
    async def add_provider_route(request: Request):
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()

        try:
            return back(
                "ok",
                add_provider(
                    user.email, providers=providers, store=store,
                    provider=str(form.get("provider") or ""),
                    raw_key=form.get("api_key"),
                    name=str(form.get("name") or ""),
                    model=str(form.get("model") or ""),
                    make_default=form.get("make_default") in ("on", "1"),
                ),
            )
        except FlowError as refused:
            return back("err", refused.message)

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
        reading the trail can see who looked and when. Console only: the app's
        screens never receive a key.
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

    def run(step) -> RedirectResponse:
        try:
            return back("ok", step())
        except FlowError as refused:
            return back("err", refused.message)

    @router.post("/console/settings/ai/{provider_id}")
    async def update_provider_route(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        form = await request.form()

        return run(
            lambda: update_provider(
                user.email, provider_id, providers=providers, store=store,
                name=str(form.get("name") or ""),
                model=str(form.get("model") or ""),
                raw_key=form.get("api_key"),
                enabled=str(form.get("enabled") or "1") == "1",
            )
        )

    @router.post("/console/settings/ai/{provider_id}/default")
    def set_default(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        return run(lambda: make_default_provider(user.email, provider_id, providers=providers, store=store))

    @router.post("/console/settings/ai/{provider_id}/delete")
    def delete_provider(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        return run(lambda: remove_provider(user.email, provider_id, providers=providers, store=store))

    @router.post("/console/settings/ai/{provider_id}/test")
    def test_provider_route(request: Request, provider_id: int):
        user, response = guard(request)

        if response is not None:
            return response

        return run(lambda: test_provider(provider_id, providers=providers, usage=usage))

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

        try:
            return back(
                "ok",
                assign_site_model(
                    site, user.email, providers=providers, store=store,
                    raw_provider_id=raw, raw_model=str(form.get("model") or ""),
                ),
            )
        except FlowError as refused:
            return back("err", refused.message)

    return router
