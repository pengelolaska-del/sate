<?php

declare(strict_types=1);

namespace App\Support;

/** Filter "Tender" juga mencakup "Seleksi" (sama-sama kompetitif via SPSE). */
final class SumberTransaksi
{
    public const GABUNGAN = ['Tender' => ['Tender', 'Seleksi']];

    public static function match(?string $rowValue, ?string $filter): bool
    {
        if (! $filter) {
            return true;
        }
        $group = self::GABUNGAN[$filter] ?? null;

        return $group ? in_array($rowValue, $group, true) : $rowValue === $filter;
    }

    /** Paket yang belum ada realisasi dicocokkan lewat metode RUP-nya. */
    public static function rowMatches(array $row, ?string $filter): bool
    {
        if (! $filter) {
            return true;
        }
        if (! empty($row['ada_realisasi'])) {
            return self::match($row['sumber_transaksi'] ?? null, $filter);
        }
        $group = self::GABUNGAN[$filter] ?? null;

        return $group !== null && in_array($row['metode_pengadaan_rup'] ?? null, $group, true);
    }

    /** Label kelompok untuk metode RUP yang belum direalisasikan (mis. Seleksi → "Tender"). */
    public static function groupLabel(?string $metodeRup): ?string
    {
        foreach (self::GABUNGAN as $label => $members) {
            if (in_array($metodeRup, $members, true)) {
                return $label;
            }
        }

        return null;
    }
}
