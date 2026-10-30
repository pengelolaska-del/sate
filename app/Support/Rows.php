<?php

declare(strict_types=1);

namespace App\Support;

/**
 * PDO pgsql mengembalikan kolom float/numeric sebagai string.
 * Frontend memakai angka, jadi kolom numerik di-cast di sini.
 */
final class Rows
{
    private const NUMERIC = [
        'id', 'bulan', 'tahun', 'pagu', 'pagu_rup', 'nilai_kontrak', 'nilai_pdn',
        'efisiensi', 'persen_efisiensi', 'similarity_score',
        'total_pagu', 'total_kontrak', 'total_efisiensi', 'total_nilai_pdn', 'persen_pdn',
        'total_pagu_selesai', 'total_kontrak_selesai', 'total_efisiensi_selesai',
        'persen_efisiensi_selesai', 'total_nilai', 'value',
    ];

    public static function cast(object|array $row): array
    {
        $row = (array) $row;
        foreach ($row as $k => $v) {
            if (! is_string($v) && ! is_int($v) && ! is_float($v)) {
                continue;
            }
            if (in_array($k, self::NUMERIC, true) || str_starts_with((string) $k, 'jumlah_')) {
                $row[$k] = is_numeric($v) ? $v + 0 : $v;
            }
        }

        return $row;
    }

    /** @return list<array<string,mixed>> */
    public static function castAll(iterable $rows): array
    {
        $out = [];
        foreach ($rows as $r) {
            $out[] = self::cast($r);
        }

        return $out;
    }
}
