<?php

declare(strict_types=1);

namespace App\Support;

/** Envelope respons yang dipakai frontend: {status, code, message?, data?} */
final class Api
{
    public static function ok(mixed $data = null, ?string $message = null): array
    {
        $out = ['status' => 'success', 'code' => 200];
        if ($message !== null) {
            $out['message'] = $message;
        }
        if ($data !== null) {
            $out['data'] = $data;
        }

        return $out;
    }

    public static function error(string $message, int $code = 400, array $extra = []): array
    {
        return ['status' => 'error', 'code' => $code, 'message' => $message] + $extra;
    }
}
