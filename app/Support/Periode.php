<?php

declare(strict_types=1);

namespace App\Support;

final class Periode
{
    /** "2026-08" → "2026-07", "2026-01" → "2025-12" */
    public static function prev(string $periode): string
    {
        [$y, $m] = array_map('intval', explode('-', $periode));
        if (--$m < 1) {
            $m = 12;
            $y--;
        }

        return sprintf('%04d-%02d', $y, $m);
    }
}
