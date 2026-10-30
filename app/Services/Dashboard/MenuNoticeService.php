<?php

declare(strict_types=1);

namespace App\Services\Dashboard;

use App\Support\Api;
use App\Support\ApiException;
use Illuminate\Support\Facades\DB;

final class MenuNoticeService
{
    public function list(array $p): array
    {
        $menus = config('dashboard.menu_list');
        $enabled = DB::table('menu_notices')->pluck('menu_key')->all();

        return Api::ok([
            'menu_options' => $menus,
            'enabled' => array_values(array_filter(array_column($menus, 'key'), fn ($k) => in_array($k, $enabled, true))),
        ]);
    }

    public function save(array $p): array
    {
        $enabled = $p['enabled'] ?? null;
        if (! is_array($enabled)) {
            throw new ApiException('Parameter enabled harus berupa array menu_key.');
        }

        $valid = array_column(config('dashboard.menu_list'), 'key');
        $uniq = array_values(array_unique(array_filter(
            array_map(fn ($k) => trim((string) $k), $enabled),
            fn ($k) => in_array($k, $valid, true)
        )));

        DB::transaction(function () use ($uniq) {
            DB::table('menu_notices')->delete();
            if ($uniq) {
                DB::table('menu_notices')->insert(array_map(fn ($k) => ['menu_key' => $k], $uniq));
            }
        });

        return Api::ok(['enabled' => $uniq], 'Pengaturan notifikasi menu berhasil disimpan.');
    }
}
