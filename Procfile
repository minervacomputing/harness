web: cd backend && uv run uvicorn minerva.asgi:application --host 127.0.0.1 --port 8000 --reload
gateway: cd backend && MINERVA_ROLE=gateway uv run uvicorn gateway.asgi:application --host ${MINERVA_GATEWAY_BIND:-127.0.0.1} --port 8001
supervisor: cd backend && uv run python manage.py supervisor
frontend: cd frontend && pnpm dev
