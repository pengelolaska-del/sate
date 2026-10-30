<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Support\Api;
use App\Support\ApiException;
use App\Support\DashboardAuth;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;
use Throwable;

/** Satu endpoint RPC: POST {action, ...payload} — kontrak sama dengan frontend lama. */
final class DashboardApiController extends Controller
{
    public function __invoke(Request $request): JsonResponse
    {
        set_time_limit(300);

        $payload = $request->json()->all();
        $action = (string) ($payload['action'] ?? '');
        $entry = config("dashboard.actions.$action");

        if ($entry === null) {
            return response()->json(Api::error("Action belum tersedia: $action", 400));
        }

        [$class, $method, $adminOnly] = $entry;

        try {
            if ($adminOnly && ! DashboardAuth::check($payload['token'] ?? null)) {
                return response()->json(Api::error('Token tidak valid.', 401));
            }

            return response()->json(app($class)->{$method}($payload));
        } catch (ApiException $e) {
            return response()->json(Api::error($e->getMessage(), $e->apiCode()));
        } catch (Throwable $e) {
            Log::error("dashboard-api [$action] ".$e->getMessage(), ['trace' => $e->getTraceAsString()]);

            return response()->json(Api::error($e->getMessage(), 500));
        }
    }
}
