#!/bin/sh
set -e

# Platform (Railway/Render/Fly) mengirim port lewat env PORT
PORT="${PORT:-8080}"
sed -ri "s/^Listen .*/Listen ${PORT}/" /etc/apache2/ports.conf
sed -ri "s/<VirtualHost \*:[0-9]+>/<VirtualHost *:${PORT}>/" /etc/apache2/sites-available/000-default.conf

# Route '/' memakai closure → jangan route:cache
php artisan config:cache

# Migrasi otomatis hanya jika RUN_MIGRATIONS=true
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
    php artisan migrate --force
fi

exec apache2-foreground
