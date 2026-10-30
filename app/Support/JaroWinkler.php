<?php

declare(strict_types=1);

namespace App\Support;

final class JaroWinkler
{
    public static function similarity(string $s1, string $s2): float
    {
        if ($s1 === $s2) {
            return 1.0;
        }
        $l1 = strlen($s1);
        $l2 = strlen($s2);
        if ($l1 === 0 || $l2 === 0) {
            return 0.0;
        }

        $md = max(intdiv(max($l1, $l2), 2) - 1, 0);
        $m1 = array_fill(0, $l1, false);
        $m2 = array_fill(0, $l2, false);
        $mt = 0;
        $tr = 0;

        for ($i = 0; $i < $l1; $i++) {
            $start = max(0, $i - $md);
            $end = min($i + $md + 1, $l2);
            for ($j = $start; $j < $end; $j++) {
                if ($m2[$j] || $s1[$i] !== $s2[$j]) {
                    continue;
                }
                $m1[$i] = $m2[$j] = true;
                $mt++;
                break;
            }
        }
        if ($mt === 0) {
            return 0.0;
        }

        $k = 0;
        for ($i = 0; $i < $l1; $i++) {
            if (! $m1[$i]) {
                continue;
            }
            while (! $m2[$k]) {
                $k++;
            }
            if ($s1[$i] !== $s2[$k]) {
                $tr++;
            }
            $k++;
        }

        $jaro = ($mt / $l1 + $mt / $l2 + ($mt - $tr / 2) / $mt) / 3;
        $prefix = 0;
        $limit = min($l1, $l2, 4);
        while ($prefix < $limit && $s1[$prefix] === $s2[$prefix]) {
            $prefix++;
        }

        return $jaro + $prefix * 0.1 * (1 - $jaro);
    }
}
