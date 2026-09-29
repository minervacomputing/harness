from django.contrib import admin
from django.http import HttpResponse, JsonResponse
from django.urls import include, path
from django.views.decorators.csrf import ensure_csrf_cookie
from ninja import NinjaAPI

from agents.api import router as agents_router
from connections.api import router as connections_router
from connections.views import oauth_callback
from conversations.api import router as conversations_router
from runs.stream import run_stream
from workspaces.api import router as workspaces_router


class MinervaAPI(NinjaAPI):
    def get_openapi_operation_id(self, operation) -> str:
        return operation.view_func.__name__


api = MinervaAPI(title="Minerva API", version="1", urls_namespace="api")
api.add_router("/", workspaces_router)
api.add_router("/", connections_router)
api.add_router("/", agents_router)
api.add_router("/", conversations_router)

urlpatterns = [
    path("api/health", lambda request: JsonResponse({"ok": True})),
    path("api/csrf", ensure_csrf_cookie(lambda request: HttpResponse(status=204))),
    path("api/auth/", include("allauth.headless.urls")),
    path("api/oauth/<slug:provider>/callback", oauth_callback),
    path("api/workspaces/<uuid:workspace_id>/runs/<uuid:run_id>/stream", run_stream),
    path("api/", api.urls),
    path("admin/", admin.site.urls),
]
