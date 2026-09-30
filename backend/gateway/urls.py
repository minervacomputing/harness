from django.urls import path

from gateway import views

urlpatterns = [
    path("run", views.run_spec),
    path("events", views.events),
    path("v1/chat/completions", views.chat_completions),
    path("v1/responses", views.responses),
]
