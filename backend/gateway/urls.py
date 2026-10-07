from django.urls import path

from gateway import files, relay, views

urlpatterns = [
    path("run", views.run_spec),
    path("events", views.events),
    path("journal", views.journal),
    path("journal/<int:seq>", views.journal_commit),
    path("blobs/<str:sha256>", files.get_blob),
    path("checkpoint", files.put_checkpoint),
    path("v1/chat/completions", relay.chat_completions),
    path("v1/responses", relay.responses),
]
