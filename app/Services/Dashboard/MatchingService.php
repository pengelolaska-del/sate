<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\ApiException;
use App\Support\JaroWinkler;
use App\Support\Normalizer as N;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Mesin pencocokan RUP ↔ Realisasi.
 * Urutan: EXACT_ID (kode_rup, boleh banyak dipisah ';') → HEURISTIC (kemiripan
 * nama, hanya bila realisasi TANPA kode_rup) → fallback nama persis utk kode_rup
 * basi (HEURISTIC_NAMA_KODE_BEDA) → RUP tanpa pasangan.
 */
final class MatchingService
{
    public function __construct(private readonly AggregateService $aggregate) {}

    public function handleRun(array $p): array
    {
        $periode = $p['periode'] ?? null;
        if (! is_string($periode) || ! preg_match('/^\d{4}-\d{2}$/', $periode)) {
            throw new ApiException('Periode wajib.');
        }
        [$tahun, $bulan] = array_map('intval', explode('-', $periode));

        $res = $this->run($periode);
        $this->aggregate->build($periode, $bulan, $tahun);

        return Api::ok($res + ['periode' => $periode], 'Matching selesai.');
    }

    /** @return array{matched:int,unmatched:int,orphan:int} */
    public function run(string $periode): array
    {
        $rupAll = DB::table('rup_records')->where('periode', $periode)
            ->get(['kode_rup', 'kode_satker', 'nama_satker', 'nama_paket', 'metode_pengadaan', 'pagu'])
            ->map(fn ($r) => (array) $r)->all();
        $realAll = DB::table('realisasi_records')->where('periode', $periode)
            ->get(['kode_paket', 'kode_rup', 'kode_satker', 'nama_satker', 'nama_paket', 'metode_pengadaan', 'nilai_kontrak'])
            ->map(fn ($r) => (array) $r)->all();

        if ($rupAll === [] || $realAll === []) {
            return ['matched' => 0, 'unmatched' => 0, 'orphan' => 0];
        }

        $threshold = (float) config('dashboard.similarity_threshold');
        $aliasMap = DB::table('kode_rup_aliases')->pluck('kode_rup_baru', 'kode_rup_lama')->all();

        // ── Index RUP (per kode individual & per satker) ──
        $rupByKode = [];
        $rupBySatker = [];
        foreach ($rupAll as $i => &$r) {
            $r['_nl'] = mb_strtolower((string) $r['nama_paket']);
            foreach (N::splitKodeRup($r['kode_rup']) as $k) {
                $rupByKode[$k] = $i;
            }
            $rupBySatker[$r['kode_satker']][] = $i;
        }
        unset($r);
        foreach (array_keys($aliasMap) as $lama) {
            $baru = $this->resolveChain((string) $lama, $aliasMap);
            if (isset($rupByKode[$baru]) && ! isset($rupByKode[$lama])) {
                $rupByKode[$lama] = $rupByKode[$baru];
            }
        }

        $now = now();
        $rows = [];
        $used = [];
        $deferred = [];
        $matched = $unmatched = $orphan = 0;

        foreach ($realAll as $real) {
            $kruRaw = $this->blank($real['kode_rup']) ? null : trim((string) $real['kode_rup']);
            $parts = N::splitKodeRup($kruRaw);
            $status = 'UNMATCHED';
            $metode = 'UNMATCHED';
            $refs = [];
            $sim = null;

            if ($parts) {
                // Kecocokan kode_rup persis = bukti terkuat; 1 RUP boleh dipakai banyak realisasi.
                foreach ($parts as $k) {
                    if (isset($rupByKode[$k])) {
                        $refs[] = $rupAll[$rupByKode[$k]];
                        $used[$k] = true;
                    }
                }
                if ($refs) {
                    $status = 'MATCHED';
                    $metode = count($refs) > 1 ? 'EXACT_ID_MULTI' : 'EXACT_ID';
                    $matched++;
                } else {
                    $unmatched++; // kode_rup ada tapi tidak ada di RUP → audit manual
                }
            } else {
                $nama = $this->blank($real['nama_paket']) ? null : trim((string) $real['nama_paket']);
                $pool = $rupBySatker[$real['kode_satker']] ?? null;
                if ($nama && $pool) {
                    $nl = mb_strtolower($nama);
                    $best = 0.0;
                    $bestIdx = null;
                    foreach ($pool as $idx) {
                        $cand = $rupAll[$idx];
                        if (isset($used[$cand['kode_rup']]) || $this->blank($cand['nama_paket'])) {
                            continue;
                        }
                        $sc = JaroWinkler::similarity($nl, $cand['_nl']);
                        if ($sc > $best && $sc >= $threshold) {
                            $best = $sc;
                            $bestIdx = $idx;
                        }
                    }
                    if ($bestIdx !== null) {
                        $refs = [$rupAll[$bestIdx]];
                        $status = 'MATCHED';
                        $metode = 'HEURISTIC';
                        $sim = round($best, 3);
                        $used[$rupAll[$bestIdx]['kode_rup']] = true;
                        $matched++;
                    } else {
                        $metode = 'ORPHAN';
                        $orphan++;
                    }
                } else {
                    $metode = 'ORPHAN';
                    $orphan++;
                }
            }

            $pagu = array_sum(array_map(fn ($r) => (float) $r['pagu'], $refs));
            $namaRup = implode(', ', array_filter(array_column($refs, 'nama_paket'), fn ($v) => $v !== null && $v !== ''));
            $kodeRup = implode(';', array_column($refs, 'kode_rup'));
            $nilai = (float) $real['nilai_kontrak'];
            $efi = $status === 'MATCHED' ? $pagu - $nilai : null;

            $rows[] = [
                'matching_id' => (string) Str::uuid(), 'periode' => $periode,
                'kode_satker' => $real['kode_satker'], 'nama_satker' => $real['nama_satker'],
                'kode_rup' => $status === 'MATCHED' ? ($kodeRup !== '' ? $kodeRup : null) : $kruRaw,
                'kode_paket' => $real['kode_paket'],
                'nama_paket_rup' => $namaRup !== '' ? $namaRup : null,
                'nama_paket_realisasi' => $real['nama_paket'],
                'metode_matching' => $metode, 'similarity_score' => $sim,
                'pagu_rup' => $status === 'MATCHED' ? $pagu : null,
                'nilai_kontrak' => $nilai, 'efisiensi' => $efi,
                'persen_efisiensi' => ($efi !== null && $pagu > 0) ? round($efi / $pagu * 100, 2) : null,
                'status_matching' => $status, 'created_at' => $now,
            ];
            if ($status === 'UNMATCHED' && $parts) {
                $deferred[] = ['real' => $real, 'idx' => count($rows) - 1];
            }
        }

        // ── Fallback: kode_rup basi (SIRUP revisi) tapi satker + nama persis + metode sama + kandidat unik ──
        $normNama = fn ($t) => trim((string) preg_replace('/[^a-z0-9]+/', ' ', mb_strtolower((string) $t)));
        $normMetode = fn ($t) => (string) preg_replace('/[^a-z]+/', '', mb_strtolower((string) $t));
        $claimed = [];

        foreach ($deferred as ['real' => $real, 'idx' => $idx]) {
            $nama = $normNama($real['nama_paket']);
            $pool = $rupBySatker[$real['kode_satker']] ?? null;
            if ($nama === '' || ! $pool) {
                continue;
            }
            $mReal = $normMetode($real['metode_pengadaan']);
            $cands = [];
            foreach ($pool as $pi) {
                $cand = $rupAll[$pi];
                $ids = N::splitKodeRup($cand['kode_rup']);
                $anyUsed = (bool) array_filter($ids, fn ($k) => isset($used[$k]));
                $anyClaimed = (bool) array_filter($ids, fn ($k) => isset($claimed[$k]));
                if ((! $anyUsed || $anyClaimed) === false || $normNama($cand['nama_paket']) !== $nama) {
                    continue;
                }
                $mRup = $normMetode($cand['metode_pengadaan']);
                if ($mReal === '' || $mRup === '' || $mReal === $mRup) {
                    $cands[] = $cand;
                }
            }
            if (count($cands) !== 1) {
                continue; // 0 = tidak ada, >1 = ambigu → biarkan UNMATCHED utk manual
            }

            $rup = $cands[0];
            $pagu = (float) $rup['pagu'];
            $efi = $pagu - (float) $real['nilai_kontrak'];
            $rows[$idx] = array_merge($rows[$idx], [
                'kode_rup' => $rup['kode_rup'], 'nama_paket_rup' => $rup['nama_paket'],
                'metode_matching' => 'HEURISTIC_NAMA_KODE_BEDA', 'similarity_score' => 1,
                'pagu_rup' => $pagu, 'efisiensi' => $efi,
                'persen_efisiensi' => $pagu > 0 ? round($efi / $pagu * 100, 2) : null,
                'status_matching' => 'MATCHED',
            ]);
            foreach (N::splitKodeRup($rup['kode_rup']) as $k) {
                $used[$k] = $claimed[$k] = true;
            }
            $unmatched--;
            $matched++;
        }

        // ── RUP tanpa pasangan ──
        foreach ($rupAll as $r) {
            if (array_filter(N::splitKodeRup($r['kode_rup']), fn ($k) => isset($used[$k]))) {
                continue;
            }
            $rows[] = [
                'matching_id' => (string) Str::uuid(), 'periode' => $periode,
                'kode_satker' => $r['kode_satker'], 'nama_satker' => $r['nama_satker'],
                'kode_rup' => $r['kode_rup'], 'kode_paket' => null,
                'nama_paket_rup' => $r['nama_paket'], 'nama_paket_realisasi' => null,
                'metode_matching' => 'UNMATCHED', 'similarity_score' => null,
                'pagu_rup' => (float) $r['pagu'], 'nilai_kontrak' => null,
                'efisiensi' => null, 'persen_efisiensi' => null,
                'status_matching' => 'UNMATCHED', 'created_at' => $now,
            ];
        }

        DB::transaction(function () use ($periode, $rows) {
            DB::table('matching_results')->where('periode', $periode)->delete();
            foreach (array_chunk($rows, 500) as $chunk) {
                DB::table('matching_results')->insert($chunk);
            }
        });

        return ['matched' => $matched, 'unmatched' => $unmatched, 'orphan' => $orphan];
    }

    /** Ikuti rantai alias lama→baru→lebih baru (guard siklus). */
    private function resolveChain(string $kode, array $aliasMap): string
    {
        $cur = $kode;
        $seen = [];
        for ($hop = 0; isset($aliasMap[$cur]) && ! isset($seen[$cur]) && $hop < 20; $hop++) {
            $seen[$cur] = true;
            $cur = (string) $aliasMap[$cur];
        }

        return $cur;
    }

    private function blank(mixed $v): bool
    {
        return $v === null || trim((string) $v) === '';
    }
}
