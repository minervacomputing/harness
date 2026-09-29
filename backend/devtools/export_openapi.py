"""Print the web API's OpenAPI schema. The frontend generates its typed client from it (`pnpm gen:api`)."""

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "minerva.settings")

import django

django.setup()

from minerva.urls import api  # noqa: E402

print(json.dumps(api.get_openapi_schema(), indent=2, sort_keys=True))
