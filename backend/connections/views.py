from urllib.parse import urlencode
from uuid import UUID

from django.http import HttpRequest, HttpResponseRedirect
from django.views.decorators.http import require_GET

from connections import services
from connections.models import Connection
from connectors import registry
from minerva.config import config
from workspaces.models import Membership
from workspaces.tenancy import workspace_scope


def _redirect(path: str, **params: str) -> HttpResponseRedirect:
    query = f"?{urlencode(params)}" if params else ""
    return HttpResponseRedirect(f"{config().site_url}{path}{query}")


@require_GET
def oauth_callback(request: HttpRequest, provider: str) -> HttpResponseRedirect:
    if not request.user.is_authenticated:
        return _redirect("/login")
    try:
        connector = registry.get(provider)
    except LookupError:
        return _redirect("/")
    try:
        flow = services.pop_flow(request.session, provider=provider, state=request.GET.get("state"))
    except services.ConnectionFlowError as error:
        return _redirect("/", error=str(error))
    workspace_id = UUID(flow["workspace_id"])
    page = f"/w/{workspace_id}/connections"
    membership = Membership.objects.filter(workspace_id=workspace_id, user=request.user).first()
    if membership is None:
        return _redirect("/")
    if request.GET.get("error") or not request.GET.get("code"):
        return _redirect(page, error=f"{connector.name} was not connected.")
    target = UUID(flow["connection_id"]) if flow.get("connection_id") else None
    try:
        with workspace_scope(workspace_id):
            if target is not None:
                existing = Connection.objects.filter(pk=target).first()
                if existing is not None and existing.owner_id not in (None, request.user.id):
                    return _redirect(page, error="This connection belongs to someone else.")
                if existing is not None and existing.owner_id is None and not membership.is_admin:
                    return _redirect(page, error="Only workspace admins can reconnect shared connections.")
            tokens = services.exchange_code(connector, code=request.GET["code"], flow=flow)
            connection = services.save_connection(
                workspace_id=workspace_id,
                owner_id=request.user.id,
                provider=provider,
                tokens=tokens,
                connection_id=target,
            )
    except services.ConnectionFlowError as error:
        return _redirect(page, error=str(error))
    return _redirect(page, connected=str(connection.id))
