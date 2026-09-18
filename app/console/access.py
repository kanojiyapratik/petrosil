"""Who may use which website.

Ordinary users see only the sites a superadmin has given them. A superadmin
sees every site and is given no rows in the grants table at all: two sources
of truth for the same answer would only ever drift apart.

The check lives here and nowhere else. A dozen screens resolve a site from a
slug someone can type into the address bar, and three list sites; a check
copied into each of them is a check one of them will be missing, and the one
that is missing is how a user reaches a site nobody meant them to have. Every
one of those screens now goes through visible_site(), managed_site() or
visible_sites(), and every router's site guard is built by make_site_guard().

A user without access gets the same 404 "no such site" a hidden site gives.
A 403 would confirm the site exists, which is exactly what this is meant to
keep quiet about.
"""

from __future__ import annotations

from fastapi import Request
from fastapi.responses import RedirectResponse

NO_SUCH_SITE = "That site is not configured, or has been turned off."
NOT_ALLOWED = "Only an administrator can change these settings."
SUPERADMIN_ONLY = "Only the superadmin can change this."


def is_superadmin(user) -> bool:
    return bool(user is not None and user.is_superadmin)


def may_change_settings(user) -> bool:
    """is_admin still answers "may change settings" on its own; superadmin
    implies it, so the two questions stay separate without a superadmin ever
    being locked out of a screen an administrator can reach."""
    return bool(user is not None and (user.is_admin or user.is_superadmin))


def may_use_slug(store, user, slug: str) -> bool:
    if user is None:
        return False

    if is_superadmin(user):
        return True

    return slug in store.granted_slugs(user.id)


def visible_site(store, user, slug: str):
    """The site behind a slug on a working screen, or None.

    One None covers all three reasons -- no such site, hidden, not granted --
    because from outside they have to look identical.

    Hidden does not apply to the superadmin. The switch exists so they can
    keep a site from everyone else while it is being set up; applying it to
    them as well would mean the one person who can turn it back on cannot
    open it to check on it first.
    """
    site = store.site_by_slug(slug)

    if site is None:
        return None

    if not site.enabled and not is_superadmin(user):
        return None

    return site if may_use_slug(store, user, site.slug) else None


def managed_site(store, user, slug: str):
    """The same on a settings screen, where a hidden site must still resolve:
    otherwise the Show switch could never turn one back on."""
    site = store.site_by_slug(slug)

    if site is None:
        return None

    return site if may_use_slug(store, user, site.slug) else None


def visible_sites(store, user, sites):
    """Filters any list of sites down to the ones this user may use."""
    if is_superadmin(user):
        return list(sites)

    if user is None:
        return []

    allowed = store.granted_slugs(user.id)

    return [site for site in sites if site.slug in allowed]


def sites_for(store, user):
    """Every site this user should be offered, hidden ones included or not.

    The superadmin gets the whole list, hidden sites among them: they decide
    what everyone else sees, so filtering their own view by that same switch
    would hide the sites they most need to look at. Everyone else gets the
    sites they were granted, and only the ones that are shown.

    Callers should reach for this rather than choosing between sites() and
    enabled_sites() themselves -- picking the wrong one is how the superadmin
    ended up seeing two sites out of nine.
    """
    return visible_sites(store, user, store.sites() if is_superadmin(user) else store.enabled_sites())


def _page(templates, request: Request, user, title: str, message: str, status: int):
    # Imported here rather than at the top: routes imports this module, and
    # the screens' shared tone table lives there.
    from .routes import tone_for

    return templates.TemplateResponse(
        request,
        "error.html",
        {
            "user": user,
            "flash": None,
            "site": None,
            "section": None,
            "crumbs": None,
            "tone_for": tone_for,
            "title": title,
            "message": message,
        },
        status_code=status,
    )


def no_such_site(templates, request: Request, user):
    return _page(templates, request, user, "No such site", NO_SUCH_SITE, 404)


def not_allowed(templates, request: Request, user, message: str = NOT_ALLOWED):
    return _page(templates, request, user, "Not allowed", message, 403)


def make_site_guard(*, store, templates, current_user):
    """The one site guard. Returns (user, site, response-to-send-instead)."""

    def guard(request: Request, slug: str):
        user = current_user(request)

        if user is None:
            return None, None, RedirectResponse("/console/login", status_code=303)

        site = visible_site(store, user, slug)

        if site is None:
            return user, None, no_such_site(templates, request, user)

        return user, site, None

    return guard
