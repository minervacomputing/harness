from django.contrib import admin

from demo.models import DemoLead, DemoSite


@admin.register(DemoSite)
class DemoSiteAdmin(admin.ModelAdmin):
    list_display = ["workspace", "created_at"]


@admin.register(DemoLead)
class DemoLeadAdmin(admin.ModelAdmin):
    list_display = ["email", "newsletter", "source", "created_at", "last_seen_at", "synced_to", "synced_at"]
    list_filter = ["newsletter", "source", "synced_to"]
    search_fields = ["email"]
    readonly_fields = ["created_at", "last_seen_at", "synced_to", "synced_at"]
