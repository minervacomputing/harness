from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('runs', '0004_unmetered_model_calls'),
    ]

    operations = [
        migrations.AddField(
            model_name='run',
            name='max_tool_calls',
            field=models.PositiveIntegerField(default=100),
            preserve_default=False,
        ),
        migrations.AddField(
            model_name='run',
            name='tool_calls',
            field=models.PositiveIntegerField(default=0),
        ),
    ]
