.PHONY: setup services migrate worker-image sandbox-check dev fake-model test lint api-types

setup: services
	cd backend && uv sync
	cd worker && pnpm install --frozen-lockfile
	cd frontend && pnpm install --frozen-lockfile
	$(MAKE) migrate worker-image

services:
	docker compose up -d --wait

migrate:
	cd backend && uv run python manage.py migrate

worker-image:
	docker build -t minerva-worker:dev worker

# Requires the gateway to be running (make dev, or the gateway line of the Procfile).
sandbox-check:
	cd backend && uv run python manage.py sandbox_check

dev:
	cd backend && uv run honcho -f ../Procfile -d .. start

# A scripted OpenAI-compatible model for trying the app without a provider key.
fake-model:
	cd backend && uv run python devtools/fake_model.py

test:
	cd backend && uv run pytest -q
	cd worker && pnpm typecheck
	cd frontend && pnpm typecheck

lint:
	cd backend && uv run ruff check . && uv run ruff format --check .

api-types:
	cd frontend && pnpm gen:api
