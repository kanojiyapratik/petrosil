# The module: FastAPI serving the JSON API and the admin console.
#
# One image, one language. The crawler is the same image run with a different
# command (see CRAWLER.md and htdocs/docker-compose.yml), so the site client,
# the models and the AI driver exist once rather than once per process.
FROM python:3.12-slim

WORKDIR /app

# Installed before the source so a code edit does not reinstall the deps.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY scraper ./scraper

# Unbuffered so `docker logs` shows what happened as it happens, not when the
# buffer fills.
ENV PYTHONUNBUFFERED=1

# Railway injects PORT; the shell form is what expands it. MODULE_PROCESS is
# how the crawler service runs from this same image: Railway offers no
# per-service start command from the CLI, so the env var is the switch.
# (Local compose passes an explicit `command:` instead and ignores this.)
# MODULE_PROCESS=estate-crawler is the Petrosil app's crawler: every brand in
# the engine's own table, each with its own provider (scraper/estate.py).
CMD if [ "$MODULE_PROCESS" = "crawler" ]; then exec python -m scraper.main; elif [ "$MODULE_PROCESS" = "estate-crawler" ]; then exec python -m scraper.estate; else exec uvicorn app.main:create_app --factory --host 0.0.0.0 --port ${PORT:-8094}; fi
