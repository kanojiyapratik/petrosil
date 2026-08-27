"""The module: one process serving the JSON API and the admin console.

The crawler is the second process (see scraper/), and shares this package's
site client so the contract exists once rather than twice.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.templating import Jinja2Templates

from .ai.gemini import GeminiDriver
from .ai.providers import create_driver
from .api import create_api
from .console.config import ConsoleConfigError, parse_seed_sites, parse_seed_users
from .console.routes import create_console, datefmt, label_for
from .console.routes_ai import create_ai_routes
from .console.routes_editorial import create_editorial_routes
from .console.routes_prices import create_price_routes
from .console.routes_rules import create_rules_routes
from .db.migrate import migrate
from .db.pool import create_pool
from .db.store import FxStore, ProviderStore, RulesStore, Store, UsageStore, seed
from .editorial.fx import CachedRates, FrankfurterRates

logger = logging.getLogger("module")

TEMPLATES = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

# Every screen shows statuses; label_for turns the wire values ("committed",
# "unmatched") into words an editor would use. A global beats threading it
# through every TemplateResponse context.
TEMPLATES.env.globals["label_for"] = label_for
TEMPLATES.env.globals["datefmt"] = datefmt


def create_app() -> FastAPI:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )

    api_token = os.environ.get("PRICE_API_TOKEN", "")
    api_key = os.environ.get("GOOGLE_GENERATIVE_AI_API_KEY", "")

    # Fail loudly at boot rather than 401/500ing every request later. The auth
    # dependency also fails closed, but a service started without its token is
    # a misconfiguration, not a runtime condition worth serving through.
    if api_token == "":
        logger.error("PRICE_API_TOKEN is not set — refusing to start.")
        sys.exit(1)

    if api_key == "":
        logger.error("GOOGLE_GENERATIVE_AI_API_KEY is not set — refusing to start.")
        sys.exit(1)

    app = FastAPI(title="Petrosil price module", docs_url=None, redoc_url=None)

    def configured_driver():
        """The provider an admin chose, if the console is running."""
        providers = getattr(app.state, "providers", None)

        if providers is None:
            return None

        chosen = providers.default()

        if chosen is None:
            return None

        driver = create_driver(chosen.provider, chosen.api_key, chosen.model)
        # The usage ledger records per provider; the driver carries its own
        # name so the recorder does not have to guess from the class.
        driver.provider_key = chosen.provider

        return driver

    boot_driver = GeminiDriver(api_key=api_key)
    default_model = os.environ.get("AI_DEFAULT_MODEL", "gemini-2.5-flash")

    def record_use(**entry):
        """The API's usage recorder. Bound late through app.state because the
        console (and its database) mounts after this router is built."""
        usage = getattr(app.state, "usage", None)

        if usage is not None:
            usage.record(**entry)

    # Exchange rates for report figures printed in another currency. With
    # the console running they are cached in its database; without it, the
    # API still converts, it just asks Frankfurter every time.
    frankfurter = FrankfurterRates()

    class ConfiguredRates:
        def get(self, currency, on_date):
            cached = getattr(app.state, "fx", None)

            return (cached or frankfurter).get(currency, on_date)

    rates = ConfiguredRates()

    app.include_router(
        create_api(
            api_token=api_token,
            driver=boot_driver,
            default_model=default_model,
            driver_for=configured_driver,
            record_use=record_use,
            fx=rates,
        )
    )

    @app.get("/health")
    def health():
        return {"ok": True}

    @app.get("/", include_in_schema=False)
    def root():
        """The module's front door is the console.

        Without this, the root answered FastAPI's default {"detail":"Not
        Found"} -- which reads as a broken deployment to anyone who opens the
        URL in a browser rather than as "you want /console".
        """
        return RedirectResponse("/console", status_code=307)

    @app.exception_handler(404)
    def not_found(request: Request, _exc):
        """A machine gets JSON, a person gets a page.

        The API's callers are PHP sites parsing JSON, so /api must keep
        answering JSON; everything else is opened in a browser.
        """
        if request.url.path.startswith("/api"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)

        return TEMPLATES.TemplateResponse(
            request, "notfound.html", {"path": request.url.path}, status_code=404
        )

    _mount_console(
        app, driver=boot_driver, default_model=default_model, driver_for=configured_driver
    )

    return app


def _mount_console(app: FastAPI, *, driver, default_model: str, driver_for) -> None:
    """The console, if this deployment is meant to serve one.

    Off unless DATABASE_URL and CONSOLE_SECRET are both set, so an API-only
    deployment publishes no login page. Misconfiguration is a hard failure
    rather than a half-working console: a database it cannot reach, or a
    signing secret it does not have, would otherwise surface as a blank site
    list nobody could explain.
    """
    database_url = os.environ.get("DATABASE_URL", "")
    secret = os.environ.get("CONSOLE_SECRET", "")

    if database_url == "" and secret == "":
        return

    if database_url == "" or secret == "":
        logger.error("The console needs both DATABASE_URL and CONSOLE_SECRET — refusing to start.")
        sys.exit(1)

    if len(secret) < 32:
        logger.error("CONSOLE_SECRET must be at least 32 characters — refusing to start.")
        sys.exit(1)

    try:
        pool = create_pool(database_url)
        # Migrations run here because the production database is Railway's,
        # reachable only from inside their network: a deploy is the only thing
        # that can migrate it, so the deploy does.
        ran = migrate(pool)

        if ran:
            logger.info("applied %d migration(s): %s", len(ran), ", ".join(ran))

        store = Store(pool)

        # CONSOLE_SITES / CONSOLE_USERS were how this was configured before the
        # database existed. They still seed a fresh install, and never
        # overwrite anything edited through the screens.
        seeded = seed(
            store,
            parse_seed_users(os.environ.get("CONSOLE_USERS")),
            parse_seed_sites(os.environ.get("CONSOLE_SITES")),
        )

        if seeded["users"] or seeded["sites"]:
            logger.info(
                "seeded %d user(s) and %d site(s) from the environment",
                seeded["users"],
                seeded["sites"],
            )

        users = store.users()

        if not users:
            logger.error(
                "The console has no users. Seed one with CONSOLE_USERS — otherwise nobody can sign in."
            )
            sys.exit(1)

        secure_cookies = os.environ.get("CONSOLE_INSECURE_COOKIES", "") != "1"
        usage = UsageStore(pool)
        console = create_console(
            store=store,
            providers=ProviderStore(pool),
            secret=secret,
            templates=TEMPLATES,
            secure_cookies=secure_cookies,
            driver=driver,
            default_model=default_model,
            driver_for=driver_for,
            usage=usage,
        )

        # The price screens need the same "who is asking" the console already
        # works out, so they are handed its own resolver rather than a second
        # copy of it.
        from .console.auth import SESSION_COOKIE, read_session

        def current_user(request):
            session = read_session(request.cookies.get(SESSION_COOKIE), secret)

            if session is None:
                return None

            return next((u for u in store.active_users() if u.email == session.email), None)

        provider_store = ProviderStore(pool)
        rules = RulesStore(pool)
        app.state.fx = CachedRates(FrankfurterRates(), FxStore(pool))

        app.include_router(console)
        app.include_router(
            create_price_routes(store=store, templates=TEMPLATES, current_user=current_user)
        )
        app.include_router(
            create_editorial_routes(
                store=store,
                templates=TEMPLATES,
                current_user=current_user,
                driver=driver,
                default_model=default_model,
                driver_for=driver_for,
                usage=usage,
                rules=rules,
                fx=app.state.fx,
            )
        )
        app.include_router(
            create_rules_routes(
                store=store,
                rules=rules,
                templates=TEMPLATES,
                current_user=current_user,
            )
        )
        app.include_router(
            create_ai_routes(
                store=store,
                providers=provider_store,
                templates=TEMPLATES,
                current_user=current_user,
                usage=usage,
            )
        )

        # The price-review API picks its model the same way the crawler does:
        # from the database when the console is configured, from the
        # environment otherwise. Setting it after the router is built means an
        # admin changing the default takes effect without a redeploy.
        app.state.providers = provider_store
        app.state.usage = usage

        logger.info(
            "console enabled: %d user(s), %d site(s)", len(users), len(store.sites())
        )
    except ConsoleConfigError as error:
        logger.error("%s", error)
        sys.exit(1)


# No module-level app: create_app() checks its environment and exits when the
# configuration is wrong, so importing this module would kill anything that
# imported it -- a test runner included. uvicorn is pointed at the factory.
