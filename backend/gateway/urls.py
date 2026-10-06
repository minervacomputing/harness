from django.urls import path

from gateway import relay, views

urlpatterns = [
    path("run", views.run_spec),
    path("events", views.events),
    path("journal", views.journal),
    path("journal/<int:seq>", views.journal_commit),
    path("v1/chat/completions", relay.chat_completions),
    path("v1/responses", relay.responses),
]
