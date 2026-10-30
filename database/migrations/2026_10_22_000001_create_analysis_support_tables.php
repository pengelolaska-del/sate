<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // Metode yang dikecualikan dari perhitungan efisiensi (mis. E-Purchasing)
        Schema::create('efisiensi_exclude_metode', function (Blueprint $t) {
            $t->id();
            $t->string('metode')->unique();
            $t->timestampTz('updated_at')->useCurrent();
        });

        // Pagu manual per kode_paket (paket yang belum match ke RUP)
        Schema::create('manual_pagu', function (Blueprint $t) {
            $t->id();
            $t->string('kode_paket')->unique();
            $t->double('pagu')->default(0);
            $t->text('keterangan')->nullable();
            $t->string('updated_by', 100)->default('admin');
            $t->timestampTz('updated_at')->useCurrent();
        });

        // Override status per kode_rup: 'Dibatalkan' atau 'Manual' (disandingkan tangan)
        Schema::create('status_overrides', function (Blueprint $t) {
            $t->id();
            $t->string('kode_rup')->unique();
            $t->string('override_type', 20);
            $t->text('keterangan')->nullable();
            $t->string('kode_paket_manual')->nullable();
            $t->text('nama_paket_manual')->nullable();
            $t->text('nama_penyedia_manual')->nullable();
            $t->double('nilai_kontrak_manual')->nullable();
            $t->string('status_manual', 50)->nullable();
            $t->timestampTz('updated_at')->useCurrent();
        });

        // Kontrak yang dipisah admin dari grup "1 kode RUP dipakai banyak kontrak"
        Schema::create('kontrak_splits', function (Blueprint $t) {
            $t->id();
            $t->string('kode_paket')->unique();
            $t->string('kode_rup');
            $t->string('periode', 7)->nullable();
            $t->double('pagu')->default(0);
            $t->string('sumber_pagu', 50)->nullable();
            $t->timestampTz('updated_at')->useCurrent();
        });
    }

    public function down(): void
    {
        foreach (['kontrak_splits', 'status_overrides', 'manual_pagu', 'efisiensi_exclude_metode'] as $t) {
            Schema::dropIfExists($t);
        }
    }
};
