from types import SimpleNamespace
from urllib.parse import urlsplit

from allauth.account.adapter import DefaultAccountAdapter
from django.http import HttpRequest

from minerva.config import config


class AccountAdapter(DefaultAccountAdapter):
    def is_open_for_signup(self, request: HttpRequest) -> bool:
        return config().signup_open

    def send_mail(self, template_prefix: str, email: str, context: dict) -> None:
        # Without the sites framework, emails would name the request host instead of the product.
        site = SimpleNamespace(name="Minerva", domain=urlsplit(config().site_url).netloc)
        super().send_mail(template_prefix, email, {"current_site": site, **context})
