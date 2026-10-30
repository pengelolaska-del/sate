<?php

declare(strict_types=1);

namespace App\Support;

final class DashboardAuth
{
    public static function check(mixed $token): bool
    {
        $expected = (string) config('dashboard.admin_token');

        return $expected !== '' && hash_equals($expected, (string) $token);
    }

    public function verify(array $p): array
    {
        return self::check($p['token'] ?? null)
            ? Api::ok(['valid' => true])
            : Api::error('Token tidak valid.', 401, ['data' => ['valid' => false]]);
    }
}
