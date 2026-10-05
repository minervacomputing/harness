"""Locks a public demo instance down to what visitors need: signing in and chatting.

Requests that start a sign-in (sending a code, starting OAuth) need a recent Turnstile admission.
Signed-in visitors may change only their own conversations and runs and sign out; everything else that
changes state is refused, as is browsing a connected account's resources.
"""

import re

from asgiref.sync import iscoroutinefunction, markcoroutinefunction, sync_to_async
from django.http import HttpResponseRedirect, JsonResponse

from demo import services

UNSAFE = {"POST", "PUT", "PATCH", "DELETE"}
AUTH = "/api/auth/browser/v1/"
UUID = r"[0-9a-f-]{36}"
WORKSPACE = rf"/api/workspaces/{UUID}"

# Each use counts against the admission.
ADMITTED = {
    f"{AUTH}auth/code/request",
    f"{AUTH}auth/code/resend",
    f"{AUTH}auth/email/verify/resend",
    f"{AUTH}auth/provider/redirect",
}
# Not offered in the demo, and outside the security check: passwords, passkeys, plain signup, app-token
# and pending-signup social flows.
CLOSED = {
    f"{AUTH}auth/login",
    f"{AUTH}auth/webauthn/login",
    f"{AUTH}auth/webauthn/signup",
    f"{AUTH}auth/signup",
    f"{AUTH}auth/password/request",
    f"{AUTH}auth/password/reset",
    f"{AUTH}auth/provider/token",
    f"{AUTH}auth/provider/signup",
}
VISITOR_WRITES = [
    re.compile(rf"^{WORKSPACE}/conversations$"),
    re.compile(rf"^{WORKSPACE}/conversations/{UUID}$"),
    re.compile(rf"^{WORKSPACE}/conversations/{UUID}/messages$"),
    re.compile(rf"^{WORKSPACE}/runs/{UUID}/cancel$"),
    re.compile(rf"^{AUTH}auth/session$"),
    re.compile(r"^/api/demo/"),
]
VISITOR_READS_REFUSED = [
    # Calls the provider with the shared account, outside the permission layers.
    re.compile(rf"^{WORKSPACE}/connections/{UUID}/access/resources$"),
    re.compile(r"^/api/oauth/"),
]
# Only the providers' callbacks, including Apple's cross-site POST and its same-site finish step.
SOCIAL_CALLBACK = re.compile(r"^/api/accounts/(google|apple)/login/callback/(finish/)?$")

NOT_AVAILABLE = "Not available in the demo."


def _refuse(status: int, message: str) -> JsonResponse:
    # Both shapes: Ninja's `detail` and allauth headless `errors`.
    return JsonResponse(
        {"status": status, "detail": message, "errors": [{"message": message}]}, status=status
    )


class DemoMiddleware:
    # Async-capable, so async views (event streams, the model relay) are not forced through a thread.
    sync_capable = True
    async_capable = True

    def __init__(self, get_response) -> None:
        self.get_response = get_response
        if iscoroutinefunction(get_response):
            markcoroutinefunction(self)

    def __call__(self, request):
        if iscoroutinefunction(self):
            return self.__acall__(request)
        refused = self._check(request) if services.enabled() else None
        return refused if refused is not None else self.get_response(request)

    async def __acall__(self, request):
        refused = await sync_to_async(self._check)(request) if services.enabled() else None
        return refused if refused is not None else await self.get_response(request)

    def _check(self, request):
        path, method = request.path, request.method
        if path.startswith("/api/accounts/") and not SOCIAL_CALLBACK.match(path):
            return _refuse(404, "Not found.")
        if path.startswith("/admin/"):
            return None
        if method in UNSAFE and path in CLOSED:
            return _refuse(403, NOT_AVAILABLE)
        if method in UNSAFE and path in ADMITTED and not request.user.is_authenticated:
            if not services.use_admission(request.session):
                if path.endswith("/provider/redirect"):
                    # A form post from the browser: send the visitor back to start again.
                    return HttpResponseRedirect("/demo?error=expired")
                return _refuse(403, "The security check expired. Reload the page and try again.")
            return None
        if not services.is_visitor(request.user):
            return None
        if method in UNSAFE and not any(p.match(path) for p in VISITOR_WRITES):
            return _refuse(403, NOT_AVAILABLE)
        if method not in UNSAFE and any(p.match(path) for p in VISITOR_READS_REFUSED):
            return _refuse(403, NOT_AVAILABLE)
        return None
