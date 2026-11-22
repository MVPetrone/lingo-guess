<?php
/**
 * The player's archive blob.
 *
 * GET returns it; PUT replaces it with optimistic concurrency: the client
 * names the `updated_at` it last saw, and if the row has moved on since, the
 * write is refused with 409 and the current copy, so the client can merge and
 * retry. The server never interprets game state — it only checks the blob is
 * JSON and within size.
 */
declare(strict_types=1);

require __DIR__ . '/../lib/bootstrap.php';

const SYNC_MAX_DATA = 262144;
// The blob arrives as a JSON string inside JSON: escaping can double it.
const SYNC_MAX_BODY = 2 * SYNC_MAX_DATA + 4096;

security_headers(true);

if (!is_installed()) {
    json_out(['error' => 'not_installed'], 503);
}

require_method('GET', 'PUT');
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

if ($method === 'GET') {
    $player = require_session();
    if (!rate_limit('sync:' . $player['id'], 60, 60)) {
        json_out(['error' => 'rate_limited'], 429);
    }
    $stmt = db()->prepare('SELECT data_json, data_updated_at FROM players WHERE id = ?');
    $stmt->execute([$player['id']]);
    $row = $stmt->fetch() ?: ['data_json' => null, 'data_updated_at' => 0];
    json_out(['data' => $row['data_json'], 'updated_at' => (int) $row['data_updated_at']]);
}

require_client_header();
require_player_origin();

// Size before identity: an oversized body is refused without touching the session table.
$declared = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($declared > SYNC_MAX_BODY) {
    json_out(['error' => 'payload_too_large'], 413);
}
$body = read_json_body(SYNC_MAX_BODY);
$data = $body['data'] ?? null;
if (is_string($data) && strlen($data) > SYNC_MAX_DATA) {
    json_out(['error' => 'payload_too_large'], 413);
}

$player = require_session();
if (!rate_limit('sync:' . $player['id'], 60, 60)) {
    json_out(['error' => 'rate_limited'], 429);
}

$base = $body['base_updated_at'] ?? null;
if (!is_string($data) || $data === '' || !is_int($base) || $base < 0) {
    json_out(['error' => 'invalid_body'], 422);
}
$valid = function_exists('json_validate')
    ? json_validate($data, 64)
    : (json_decode($data, false, 64) !== null || strtolower(trim($data)) === 'null');
if (!$valid) {
    json_out(['error' => 'invalid_json'], 422);
}

$pdo = db();
$current = static function () use ($pdo, $player): array {
    $stmt = $pdo->prepare('SELECT data_json, data_updated_at FROM players WHERE id = ?');
    $stmt->execute([$player['id']]);
    return $stmt->fetch() ?: ['data_json' => null, 'data_updated_at' => 0];
};

$row = $current();
$stored = (int) $row['data_updated_at'];
if ($base !== $stored) {
    json_out(['error' => 'conflict', 'data' => $row['data_json'], 'updated_at' => $stored], 409);
}

// Strictly increasing, even for two writes in the same second, so a stale base
// can never match a newer row. The WHERE re-checks the base atomically.
$next = max(time(), $stored + 1);
$stmt = $pdo->prepare('UPDATE players SET data_json = ?, data_updated_at = ? WHERE id = ? AND data_updated_at = ?');
$stmt->execute([$data, $next, $player['id'], $base]);
if ($stmt->rowCount() !== 1) {
    $row = $current();
    json_out(['error' => 'conflict', 'data' => $row['data_json'], 'updated_at' => (int) $row['data_updated_at']], 409);
}

json_out(['updated_at' => $next]);
