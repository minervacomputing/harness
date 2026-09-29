import os

from minerva.config import REPO_ROOT, config, database_settings

cfg = config()

BASE_DIR = REPO_ROOT / "backend"
DEBUG = cfg.debug
SECRET_KEY = cfg.secret_key.get_secret_value()
ALLOWED_HOSTS = cfg.allowed_hosts
CSRF_TRUSTED_ORIGINS = cfg.csrf_trusted_origins

# One codebase, several process roles. The gateway role serves only worker-facing routes.
ROLE = os.environ.get("MINERVA_ROLE", "web")
ROOT_URLCONF = "gateway.urls" if ROLE == "gateway" else "minerva.urls"

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "allauth",
    "allauth.account",
    "allauth.headless",
    "allauth.mfa",
    "accounts",
    "workspaces",
    "connections",
    "permissions",
    "agents",
    "conversations",
    "runs",
    "gateway",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "workspaces.tenancy.TenantScopeMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "allauth.account.middleware.AccountMiddleware",
]
if ROLE == "gateway":
    # Workers authenticate with run tokens only: no sessions, cookies, CSRF, login, or admin here.
    MIDDLEWARE = ["django.middleware.security.SecurityMiddleware", "workspaces.tenancy.TenantScopeMiddleware"]
    INSTALLED_APPS = [
        app for app in INSTALLED_APPS if not app.startswith(("allauth", "django.contrib.admin"))
    ]
    ALLOWED_HOSTS = cfg.gateway_allowed_hosts

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

ASGI_APPLICATION = "minerva.asgi.application"

DATABASES = {
    "default": database_settings(cfg.database_url, transaction_pooling=cfg.database_transaction_pooling),
}
DIRECT_DATABASE_URL = cfg.direct_database_url or cfg.database_url

AUTH_USER_MODEL = "accounts.User"
AUTHENTICATION_BACKENDS = [
    "django.contrib.auth.backends.ModelBackend",
    "allauth.account.auth_backends.AuthenticationBackend",
]
AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator", "OPTIONS": {"min_length": 10}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# django-allauth, headless mode for the React app.
ACCOUNT_ADAPTER = "accounts.adapter.AccountAdapter"
ACCOUNT_USER_MODEL_USERNAME_FIELD = None
ACCOUNT_LOGIN_METHODS = {"email"}
ACCOUNT_SIGNUP_FIELDS = ["email*", "password1*"]
ACCOUNT_EMAIL_VERIFICATION = "mandatory"
ACCOUNT_EMAIL_VERIFICATION_BY_CODE_ENABLED = True
ACCOUNT_LOGIN_BY_CODE_ENABLED = True
ACCOUNT_PASSWORD_RESET_BY_CODE_ENABLED = True
ACCOUNT_UNIQUE_EMAIL = True
ACCOUNT_EMAIL_SUBJECT_PREFIX = "[Minerva] "
HEADLESS_ONLY = True
HEADLESS_CLIENTS = ("browser",)
HEADLESS_FRONTEND_URLS = {
    "account_confirm_email": f"{cfg.site_url}/verify-email",
    "account_reset_password": f"{cfg.site_url}/reset-password",
    "account_reset_password_from_key": f"{cfg.site_url}/reset-password",
    "account_signup": f"{cfg.site_url}/signup",
}
MFA_SUPPORTED_TYPES = ["totp", "recovery_codes", "webauthn"]
MFA_PASSKEY_LOGIN_ENABLED = True

SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

MAILERS = {"default": {"BACKEND": cfg.email_backend, "OPTIONS": cfg.email_options}}
DEFAULT_FROM_EMAIL = cfg.email_from

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {"plain": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"}},
    "handlers": {"console": {"class": "logging.StreamHandler", "formatter": "plain"}},
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {"httpx": {"level": "WARNING"}},
}
