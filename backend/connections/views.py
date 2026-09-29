from urllib.parse import urlencode
from uuid import UUID

from django.http import HttpRequest, HttpResponseRedirect
from django.views.decorators.http import require_GET

from connections import services
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
    if not Membership.objects.filter(workspace_id=workspace_id, user=request.user).exists():
        return _redirect("/")
    if request.GET.get("error") or not request.GET.get("code"):
        return _redirect(page, error=f"{connector.name} was not connected.")
    try:
        tokens = services.exchange_code(connector, code=request.GET["code"], verifier=flow["verifier"])
        with workspace_scope(workspace_id):
            connection = services.save_connection(
                workspace_id=workspace_id, owner_id=request.user.id, provider=provider, tokens=tokens
            )
    except services.ConnectionFlowError as error:
        return _redirect(page, error=str(error))
    return _redirect(page, connected=str(connection.id))
