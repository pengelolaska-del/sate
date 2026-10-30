<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>SATE BPBJ Surakarta - Unggah Data</title>
    <script src="https://tailwindcss.com"></script>
</head>
<body class="bg-gray-100 font-sans text-gray-800">

    <div class="max-w-4xl mx-auto py-10 px-4">
        <!-- Header Dashboard -->
        <div class="bg-blue-900 text-white rounded-lg p-6 shadow-md mb-8">
            <h1 class="text-2xl font-bold tracking-wide">BPBJ KOTA SURAKARTA</h1>
            <p class="text-blue-200 text-sm">Dashboard Monitoring Pengadaan — Sistem Unggah CSV</p>
        </div>

        <!-- Alert Notifikasi Sukses / Gagal -->
        @if(session('success'))
            <div class="bg-green-100 border-l-4 border-green-500 text-green-700 p-4 rounded mb-6 shadow-sm">
                <span class="font-bold">Sukses!</span> {{ session('success') }}
            </div>
        @endif

        @if(session('error'))
            <div class="bg-red-100 border-l-4 border-red-500 text-red-700 p-4 rounded mb-6 shadow-sm">
                <span class="font-bold">Error!</span> {{ session('error') }}
            </div>
        @endif

        <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
            <!-- Form 1: Upload RUP -->
            <div class="bg-white p-6 rounded-lg shadow-md border border-gray-200">
                <div class="flex items-center space-x-2 mb-4 border-b pb-2">
                    <span class="text-2xl">📋</span>
                    <h2 class="text-lg font-bold text-gray-700">Unggah Rencana (RUP)</h2>
                </div>
                <form action="{{ route('upload.rup') }}" method="POST" enctype="multipart/form-data">
                    @csrf
                    <div class="mb-4">
                        <label class="block text-sm font-semibold text-gray-600 mb-1">Periode Bulan & Tahun</label>
                        <input type="month" name="periode" required class="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                    </div>
                    <div class="mb-4">
                        <label class="block text-sm font-semibold text-gray-600 mb-1">Pilih File CSV RUP</label>
                        <input type="file" name="file_rup" accept=".csv,.txt" required class="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100">
                    </div>
                    <button type="submit" class="w-full bg-blue-700 hover:bg-blue-800 text-white font-semibold py-2 px-4 rounded transition">
                        Proses Data RUP
                    </button>
                </form>
            </div>

            <!-- Form 2: Upload Realisasi -->
            <div class="bg-white p-6 rounded-lg shadow-md border border-gray-200">
                <div class="flex items-center space-x-2 mb-4 border-b pb-2">
                    <span class="text-2xl">💰</span>
                    <h2 class="text-lg font-bold text-gray-700">Unggah Realisasi Aktual</h2>
                </div>
                <form action="{{ route('upload.realisasi') }}" method="POST" enctype="multipart/form-data">
                    @csrf
                    <div class="mb-4">
                        <label class="block text-sm font-semibold text-gray-600 mb-1">Periode Bulan & Tahun</label>
                        <input type="month" name="periode" required class="w-full border rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
                    </div>
                    <div class="mb-4">
                        <label class="block text-sm font-semibold text-gray-600 mb-1">Pilih File CSV Realisasi</label>
                        <input type="file" name="file_realisasi" accept=".csv,.txt" required class="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-green-50 file:text-green-700 hover:file:bg-green-100">
                    </div>
                    <button type="submit" class="w-full bg-green-700 hover:bg-green-800 text-white font-semibold py-2 px-4 rounded transition">
                        Proses Data Realisasi & Match
                    </button>
                </form>
            </div>
        </div>

        <!-- Footer Info -->
        <div class="mt-8 text-center text-xs text-gray-400">
            SATE Web App v1.0 • Terhubung ke Database PostgreSQL Supabase Cloud via Port 6543
        </div>
    </div>

</body>
</html>
