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

# Railway injects PORT; the shell form is what expands it.
CMD uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8094}
