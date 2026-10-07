from django.db import migrations, models


def synced_to_bento(apps, schema_editor):
    apps.get_model("demo", "DemoLead").objects.filter(synced_at__isnull=False).update(synced_to="bento")


class Migration(migrations.Migration):

    dependencies = [
        ('demo', '0003_featured_suggestion'),
    ]

    operations = [
        migrations.RenameField(
            model_name='demolead',
            old_name='synced_to_bento_at',
            new_name='synced_at',
        ),
        migrations.AddField(
            model_name='demolead',
            name='synced_to',
            field=models.CharField(blank=True, max_length=16),
        ),
        migrations.RunPython(synced_to_bento, migrations.RunPython.noop),
    ]
