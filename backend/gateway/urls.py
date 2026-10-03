from django.urls import path

from gateway import relay, views

urlpatterns = [
    path("run", views.run_spec),
    path("events", views.events),
    path("v1/chat/completions", relay.chat_completions),
    path("v1/responses", relay.responses),
]
